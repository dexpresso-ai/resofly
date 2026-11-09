/**
 * Een nieuwe organisatie inrichten, in stappen, voordat de werkruimte opengaat.
 *
 * main.tsx toont dit scherm zolang organizations.onboarding_completed_at leeg
 * is (migratie 20261107190000), aan de eigenaar of een beheerder. Een ander
 * teamlid ziet OrganizationSetupPending. De stappen, de uitleg per rechtsvorm
 * en de controles staan in src/lib/onboarding.ts.
 *
 * Elke stap slaat zijn eigen velden op (saveOnboardingSettings) zodra je op
 * Volgende drukt. Wie halverwege stopt, verliest dus niets; waar je was, staat
 * per organisatie in deze browser. De database bewaakt wat hier gekozen kan
 * worden: wie de bedrijfsgegevens mag schrijven, dat een BV de zakelijke
 * module nodig heeft, en wie mag afronden.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import {
  AlertTriangle, ArrowLeft, ArrowRight, BadgeCheck, Building2, Calculator, CalendarDays, Check, CheckCircle2,
  CreditCard, ExternalLink, Eye, EyeOff, Globe, KeyRound, Landmark, Layers, Loader2, Lock, LogOut, Mail, Palette,
  Receipt, RefreshCw, Rocket, Scale, ShieldCheck, Sparkles, Trash2, Upload, UserPlus,
} from 'lucide-react';
import { BrandMark } from '../components/BrandMark';
import { ClientAddressPicker, type AddressPickerState } from '../components/ClientAddressPicker';
import { canClaim, suggestSubdomain } from '../lib/clientDomains';
import { claimClientSubdomain, loadClientDomainsOverview, type ClientDomainsOverview } from '../services/domainService';
import { Input, Select, Textarea } from '../components/Ui';
import { logoToDataUrl } from './BrandStudio';
import { textOnColor } from '../lib/brandColor';
import {
  bookkeepingStartSuggestions, checkCompanyDraft, defaultYearResultAccount, finishCheck, fiscalYearMustBeCalendarYear,
  isDutchCountry, isIsoDate, LEGAL_FORM_GROUPS, LEGAL_FORM_INFO, mollieKeyMode, mollieKeyProblem, MONTH_NAMES,
  needsBusinessModule, normalizeCompanyDraft, onboardingProgressKey, onboardingSteps, organizationDisplayName,
  parseHourlyRateCents, parseOnboardingProgress, PAYMENT_TERM_DAYS, paymentTermsText, reachableSteps, resumeStep,
  serializeOnboardingProgress, VAT_PERIOD_LABELS,
  type CompanyDraft, type CompanyField, type OnboardingProgress, type OnboardingStep, type OnboardingStepKey,
} from '../lib/onboarding';
import {
  completeOrganizationOnboarding, loadCompanySettings, loadInvoiceMollieStatus, loadOrganizationBusinessStatus,
  loadOrganizationCreativeStatus, saveInvoiceMollieKey, saveInvoiceSendMethod, saveOnboardingSettings,
  type OnboardingSettingsPatch,
} from '../lib/repository';
import {
  getSelfServiceBillingPlans, loadBillingOverview, loadBillingPlans, markMockPaymentPaid, setBusinessAddon,
  setCreativeAddon, startSubscriptionCheckout,
} from '../services/billingService';
import { LEGAL_FORM_LABELS } from '../types';
import type {
  BillingPlan, CompanySettings, InvoiceMollieSettingsStatus, InvoiceSendMethod, LegalForm, Organization,
  OrganizationBillingOverview, OrganizationBusinessStatus, OrganizationCreativeStatus, OrganizationInvitation,
  OrganizationRole, VatReturnPeriodType,
} from '../types';

/** Waar de app heen gaat na het afronden. */
export type SetupNext = 'dashboard' | 'team' | 'agenda' | 'bank';

export interface OrganizationSetupProps {
  organization: Organization;
  role: OrganizationRole;
  organizations: Organization[];
  pendingInvitations: OrganizationInvitation[];
  initialSettings: CompanySettings | null;
  initialBusinessStatus: OrganizationBusinessStatus | null;
  initialCreativeStatus: OrganizationCreativeStatus | null;
  initialBillingOverview: OrganizationBillingOverview | null;
  userEmail: string | null;
  onSwitchOrganization: (organizationId: string) => Promise<void>;
  onAcceptInvitation: (invitationId: string) => Promise<void>;
  onSignOut: () => void;
  /** Na het afronden, met de organisatie zoals de database hem nu heeft. */
  onCompleted: (next: SetupNext, organization: Organization) => Promise<void>;
}

// ── Kleine hulpjes ──────────────────────────────────────────────────────────

/**
 * Een fout als zin voor de gebruiker. PostgREST geeft gewone objecten met een
 * `message`, geen Error; die tonen we ook. Engelse databasezinnen die een
 * gebruiker niets zeggen, vertalen we.
 */
function errorText(error: unknown, fallback: string): string {
  const raw = error instanceof Error
    ? error.message
    : (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string')
      ? String((error as { message: string }).message)
      : '';
  if (!raw) return fallback;
  if (/row-level security|permission denied/i.test(raw)) return 'Je hebt geen rechten om dit voor deze organisatie op te slaan. Alleen de eigenaar of een beheerder kan de organisatie inrichten.';
  if (/failed to fetch|networkerror|load failed/i.test(raw)) return 'Er is geen verbinding met ResoFly. Controleer je internet en probeer het opnieuw.';
  return raw;
}

function eur(cents: number | null | undefined, currency = 'EUR'): string {
  return new Intl.NumberFormat('nl-NL', { style: 'currency', currency }).format((cents ?? 0) / 100);
}

/** De bedrijfsgegevens zoals het formulier ze nodig heeft (nooit null). */
function companyDraftFrom(settings: CompanySettings | null, userEmail: string | null): CompanyDraft {
  const s = settings;
  return {
    company_name: s?.company_name ?? '',
    trade_name: s?.trade_name ?? '',
    address_line1: s?.address_line1 ?? '',
    address_line2: s?.address_line2 ?? '',
    postal_code: s?.postal_code ?? '',
    city: s?.city ?? '',
    // 'NL', 'nederland' of leeg: allemaal Nederland, zoals de keuzelijst het noemt.
    country: isDutchCountry(s?.country) ? 'Nederland' : String(s?.country),
    email: s?.email ?? userEmail ?? '',
    phone: s?.phone ?? '',
    website: s?.website ?? '',
    kvk_number: s?.kvk_number ?? '',
    vat_number: s?.vat_number ?? '',
    iban: s?.iban ?? '',
  };
}

interface VatDraft { kor: boolean; period: VatReturnPeriodType; fiscalMonth: number; startDate: string; hourlyRate: string }
function vatDraftFrom(settings: CompanySettings | null): VatDraft {
  return {
    kor: Boolean(settings?.kor_enabled),
    period: settings?.vat_return_period === 'monthly' ? 'monthly' : 'quarterly',
    fiscalMonth: settings?.fiscal_year_start_month && settings.fiscal_year_start_month >= 1 && settings.fiscal_year_start_month <= 12 ? settings.fiscal_year_start_month : 1,
    startDate: settings?.bookkeeping_start_date ?? '',
    hourlyRate: settings?.default_hourly_rate_cents != null ? String(settings.default_hourly_rate_cents / 100).replace('.', ',') : '',
  };
}

interface BrandDraft { logo: string | null; color: string }
const BRAND_COLORS = ['#F7C548', '#E8590C', '#D6336C', '#7048E8', '#1C7ED6', '#0CA678', '#2B8A3E', '#212529'];
function brandDraftFrom(settings: CompanySettings | null): BrandDraft {
  const color = settings?.brand_accent_color && /^#[0-9A-Fa-f]{6}$/.test(settings.brand_accent_color) ? settings.brand_accent_color.toUpperCase() : '#F7C548';
  return { logo: settings?.brand_logo_data_url ?? null, color };
}

interface InvoiceDraft { method: InvoiceSendMethod | null; terms: string; footer: string }
const DEFAULT_TERMS = 'Graag betalen binnen de afgesproken betalingstermijn onder vermelding van het factuurnummer.';
function invoiceDraftFrom(settings: CompanySettings | null): InvoiceDraft {
  const stored = settings?.invoice_payment_terms?.trim();
  return {
    method: settings?.invoice_send_method ?? null,
    // De standaardtekst van de database noemt geen termijn; dan stellen we
    // 14 dagen voor in plaats van een tekst die niets zegt.
    terms: stored && stored !== DEFAULT_TERMS ? stored : paymentTermsText(14, settings?.invoice_send_method ?? null),
    footer: settings?.invoice_footer ?? 'Bedankt voor het vertrouwen.',
  };
}

/**
 * Welke rechtsvorm al aangevinkt staat: een gekozen BV die nog op de module
 * wacht, of wat er is opgeslagen als iemand de stap al doorliep. Bij een
 * administratie onder een holding is de rechtsvorm bij het aanmaken gekozen
 * (create_child_organization). Anders niets: dan kiest de gebruiker zelf.
 */
function initialLegalChoice(progress: OnboardingProgress, settings: CompanySettings | null, isChild: boolean): LegalForm | null {
  if (progress.pendingLegalForm) return progress.pendingLegalForm;
  if (!settings) return null;
  if (progress.completed.includes('rechtsvorm') || isChild || settings.legal_form !== 'eenmanszaak') return settings.legal_form;
  return null;
}

/** De rechtsvorm met wat erbij hoort, zoals Instellingen → Boekhouding het ook zou zetten. */
function legalFormPatch(form: LegalForm): OnboardingSettingsPatch {
  return {
    legal_form: form,
    year_result_account_code: defaultYearResultAccount(form),
    ...(fiscalYearMustBeCalendarYear(form) ? { fiscal_year_start_month: 1 } : {}),
  };
}

// Waar je was, per organisatie. Alleen keuzes, geen gegevens of sleutels; de
// opslag kan geweigerd worden (privévenster), dan begin je opnieuw bij Welkom.
function readProgress(organizationId: string): OnboardingProgress | null {
  try { return parseOnboardingProgress(window.localStorage.getItem(onboardingProgressKey(organizationId))); } catch { return null; }
}
function writeProgress(organizationId: string, progress: OnboardingProgress): void {
  try { window.localStorage.setItem(onboardingProgressKey(organizationId), serializeOnboardingProgress(progress)); } catch { /* geen opslag: dan niet */ }
}
// Terug van de betaalpagina van Mollie: dan wachten we kort op de bevestiging.
const CHECKOUT_FLAG = 'resofly.onboarding.checkout.';
function readCheckoutFlag(organizationId: string): boolean {
  try {
    const at = Number(window.sessionStorage.getItem(CHECKOUT_FLAG + organizationId));
    return Number.isFinite(at) && at > 0 && Date.now() - at < 60 * 60 * 1000;
  } catch { return false; }
}
function writeCheckoutFlag(organizationId: string, on: boolean): void {
  try {
    if (on) window.sessionStorage.setItem(CHECKOUT_FLAG + organizationId, String(Date.now()));
    else window.sessionStorage.removeItem(CHECKOUT_FLAG + organizationId);
  } catch { /* geen opslag */ }
}

// ── Het scherm ──────────────────────────────────────────────────────────────

export function OrganizationSetup(props: OrganizationSetupProps) {
  const { organization, role, userEmail } = props;
  const organizationId = organization.id;
  const isChild = Boolean(organization.parent_organization_id);
  const isOwner = role === 'owner';
  const steps = useMemo(() => onboardingSteps({ isChild }), [isChild]);

  const [settings, setSettings] = useState<CompanySettings | null>(props.initialSettings);
  const [businessStatus, setBusinessStatus] = useState<OrganizationBusinessStatus | null>(props.initialBusinessStatus);
  const [creativeStatus, setCreativeStatus] = useState<OrganizationCreativeStatus | null>(props.initialCreativeStatus);
  const [billing, setBilling] = useState<OrganizationBillingOverview | null>(props.initialBillingOverview);
  const [mollie, setMollie] = useState<InvoiceMollieSettingsStatus | null>(null);
  const [mollieLoadError, setMollieLoadError] = useState<string | null>(null);
  // Het webadres (jansen.resofly.com): het basisdomein en de naam die al vastligt.
  const [address, setAddress] = useState<ClientDomainsOverview | null>(null);
  const [addressLoadError, setAddressLoadError] = useState<string | null>(null);

  const [progress, setProgress] = useState<OnboardingProgress>(() => {
    const saved = readProgress(organizationId);
    const known = new Set(steps.map(step => step.key));
    if (!saved) return { step: 'welkom', completed: [], pendingLegalForm: null };
    const completed = saved.completed.filter(key => known.has(key));
    const step = resumeStep(steps, new Set(completed), saved.step);
    return { step, completed, pendingLegalForm: saved.pendingLegalForm };
  });
  useEffect(() => { writeProgress(organizationId, progress); }, [organizationId, progress]);

  // De concepten per stap staan hier, niet in de stap zelf: zo verlies je niets
  // als je terug- of vooruitspringt voordat je hebt opgeslagen.
  //
  // De rechtsvorm staat pas aangevinkt als iemand hem koos. Een nieuwe
  // organisatie heeft in de database 'eenmanszaak' als standaard; die vooraf
  // aanvinken leek een keuze die niemand had gemaakt, en een bv die snel op
  // Volgende drukte, liep dan als eenmanszaak.
  const [legalChoice, setLegalChoice] = useState<LegalForm | null>(() => initialLegalChoice(progress, props.initialSettings, isChild));
  const [companyDraft, setCompanyDraft] = useState<CompanyDraft>(() => companyDraftFrom(props.initialSettings, userEmail));
  const [vatDraft, setVatDraft] = useState<VatDraft>(() => vatDraftFrom(props.initialSettings));
  const [brandDraft, setBrandDraft] = useState<BrandDraft>(() => brandDraftFrom(props.initialSettings));
  const [invoiceDraft, setInvoiceDraft] = useState<InvoiceDraft>(() => invoiceDraftFrom(props.initialSettings));
  const touchedRef = useRef(false);

  // Eén keer vers ophalen: de kern van de app kan net van vóór een wijziging in
  // een ander tabblad zijn. Wat je hier al typte, laten we staan.
  useEffect(() => {
    let alive = true;
    loadCompanySettings(organizationId).then(fresh => {
      if (!alive) return;
      setSettings(fresh);
      if (!touchedRef.current) {
        setLegalChoice(current => initialLegalChoice(progress, fresh, isChild) ?? current);
        setCompanyDraft(companyDraftFrom(fresh, userEmail));
        setVatDraft(vatDraftFrom(fresh));
        setBrandDraft(brandDraftFrom(fresh));
        setInvoiceDraft(invoiceDraftFrom(fresh));
      }
    }).catch(() => { /* dan blijven de gegevens uit de kern staan */ });
    return () => { alive = false; };
  }, [organizationId]); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshBilling = useCallback(async () => {
    const [overview, business, creative] = await Promise.all([
      isChild ? Promise.resolve(null) : loadBillingOverview(organizationId).catch(() => null),
      loadOrganizationBusinessStatus(organizationId).catch(() => null),
      loadOrganizationCreativeStatus(organizationId).catch(() => null),
    ]);
    if (!isChild) setBilling(overview);
    if (business) setBusinessStatus(business);
    if (creative) setCreativeStatus(creative);
    return { overview, business };
  }, [organizationId, isChild]);

  const refreshMollie = useCallback(async () => {
    try {
      setMollie(await loadInvoiceMollieStatus(organizationId));
      setMollieLoadError(null);
    } catch (error) {
      setMollieLoadError(errorText(error, 'De status van Mollie kon niet worden geladen.'));
    }
  }, [organizationId]);

  useEffect(() => { void refreshBilling(); void refreshMollie(); }, [refreshBilling, refreshMollie]);

  const refreshAddress = useCallback(async () => {
    try {
      setAddress(await loadClientDomainsOverview(organizationId));
      setAddressLoadError(null);
    } catch (error) {
      setAddressLoadError(errorText(error, 'Het webadres kon niet worden geladen.'));
    }
  }, [organizationId]);
  useEffect(() => { void refreshAddress(); }, [refreshAddress]);

  const savedLegalForm: LegalForm = settings?.legal_form ?? 'eenmanszaak';
  const businessActive = Boolean(businessStatus?.active);
  const pendingLegalForm = progress.pendingLegalForm && progress.pendingLegalForm !== savedLegalForm ? progress.pendingLegalForm : null;

  // Een gekozen BV (of NV, coöperatie) leggen we vast zodra de zakelijke
  // module aan staat. Dat gebeurt in de stap Abonnement, of in een ander
  // tabblad: het maakt niet uit waar.
  const [legalNotice, setLegalNotice] = useState<string | null>(null);
  const [legalSaveError, setLegalSaveError] = useState<string | null>(null);
  /** Telt op bij "Opnieuw proberen": anders draait het vastleggen na een fout niet nog eens. */
  const [legalRetry, setLegalRetry] = useState(0);
  const savingPendingRef = useRef(false);
  useEffect(() => {
    if (!pendingLegalForm || !businessActive || savingPendingRef.current) return;
    savingPendingRef.current = true;
    saveOnboardingSettings(organizationId, legalFormPatch(pendingLegalForm))
      .then(saved => {
        setSettings(saved);
        setProgress(p => ({ ...p, pendingLegalForm: null }));
        setLegalNotice(`Je administratie staat nu als ${LEGAL_FORM_LABELS[pendingLegalForm]}.`);
        setLegalSaveError(null);
      })
      .catch(error => setLegalSaveError(errorText(error, 'De rechtsvorm kon niet worden vastgelegd.')))
      .finally(() => { savingPendingRef.current = false; });
  }, [pendingLegalForm, businessActive, organizationId, legalRetry]);

  // Navigeren
  const mainRef = useRef<HTMLElement | null>(null);
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const index = Math.max(0, steps.findIndex(step => step.key === progress.step));
  const current = steps[index];
  const completedSet = useMemo(() => new Set(progress.completed), [progress.completed]);
  const reachable = useMemo(() => reachableSteps(steps, completedSet), [steps, completedSet]);
  const firstRender = useRef(true);
  useEffect(() => {
    // Naar boven, en de kop krijgt de focus: een schermlezer hoort meteen waar
    // je bent. Niet bij het openen zelf, dan zou de pagina wegspringen.
    if (firstRender.current) { firstRender.current = false; return; }
    mainRef.current?.scrollTo?.({ top: 0 });
    window.scrollTo?.({ top: 0 });
    titleRef.current?.focus({ preventScroll: true });
  }, [progress.step]);

  const goTo = useCallback((key: OnboardingStepKey) => {
    setProgress(p => ({ ...p, step: key }));
  }, []);
  const next = useCallback((options: { pendingLegalForm?: LegalForm | null } = {}) => {
    setProgress(p => {
      const at = steps.findIndex(step => step.key === p.step);
      const following = steps[Math.min(steps.length - 1, at + 1)].key;
      return {
        step: following,
        completed: p.completed.includes(p.step) ? p.completed : [...p.completed, p.step],
        pendingLegalForm: options.pendingLegalForm !== undefined ? options.pendingLegalForm : p.pendingLegalForm,
      };
    });
  }, [steps]);
  const back = useCallback(() => {
    setProgress(p => {
      const at = steps.findIndex(step => step.key === p.step);
      return { ...p, step: steps[Math.max(0, at - 1)].key };
    });
  }, [steps]);

  const save = useCallback(async (patch: OnboardingSettingsPatch) => {
    const saved = await saveOnboardingSettings(organizationId, patch);
    setSettings(saved);
    return saved;
  }, [organizationId]);

  const common: StepCommon = {
    stepNumber: index + 1,
    stepCount: steps.length,
    titleRef,
    onBack: index > 0 ? back : null,
  };

  let content: ReactNode;
  switch (current.key) {
    case 'welkom':
      content = <WelcomeStep {...common} organization={organization} isChild={isChild} steps={steps}
        invitations={props.pendingInvitations} onAcceptInvitation={props.onAcceptInvitation} onNext={() => next()} />;
      break;
    case 'rechtsvorm':
      content = <LegalFormStep {...common}
        choice={legalChoice}
        onChoose={form => { touchedRef.current = true; setLegalChoice(form); setLegalNotice(null); }}
        savedLegalForm={savedLegalForm}
        confirmed={completedSet.has('rechtsvorm') || isChild}
        businessStatus={businessStatus}
        isChild={isChild}
        onSave={async form => {
          if (needsBusinessModule(form) && !businessActive && form !== savedLegalForm) {
            // Nog niet vast te leggen: de stap Abonnement regelt de module.
            if (isChild) throw new Error('De zakelijke module staat bij de hoofdorganisatie niet aan. Zet hem daar aan bij Instellingen → Abonnement, of kies een andere rechtsvorm.');
            next({ pendingLegalForm: form });
            return;
          }
          // Ook als de rechtsvorm al zo stond (de standaard 'eenmanszaak'):
          // de resultaatrekening en het boekjaar horen er dan pas bij.
          await save(legalFormPatch(form));
          next({ pendingLegalForm: null });
        }} />;
      break;
    case 'abonnement':
      content = <PlanStep {...common}
        organizationId={organizationId}
        billing={billing}
        businessStatus={businessStatus}
        creativeStatus={creativeStatus}
        pendingLegalForm={pendingLegalForm}
        legalNotice={legalNotice}
        legalSaveError={legalSaveError}
        onRetryLegalSave={() => { setLegalSaveError(null); setLegalRetry(n => n + 1); }}
        onRefresh={refreshBilling}
        onChangeLegalForm={() => goTo('rechtsvorm')}
        onNext={() => next()} />;
      break;
    case 'bedrijf':
      content = <CompanyStep {...common}
        draft={companyDraft}
        onChange={patch => { touchedRef.current = true; setCompanyDraft(d => ({ ...d, ...patch })); }}
        legalForm={pendingLegalForm ?? savedLegalForm}
        korEnabled={Boolean(settings?.kor_enabled)}
        onSave={async () => {
          const saved = await save(normalizeCompanyDraft(companyDraft));
          // Het formulier toont daarna wat er echt staat: de postcode als
          // 3411 AB, het IBAN in groepjes van vier.
          setCompanyDraft(companyDraftFrom(saved, userEmail));
          next();
        }} />;
      break;
    case 'webadres':
      content = <AddressStep {...common}
        organizationId={organizationId}
        overview={address}
        loadError={addressLoadError}
        onRetry={refreshAddress}
        suggestion={suggestSubdomain(companyDraft.trade_name.trim() || companyDraft.company_name.trim() || settings?.trade_name || settings?.company_name)}
        onSaved={async () => { await refreshAddress(); next(); }} />;
      break;
    case 'btw':
      content = <VatStep {...common}
        draft={vatDraft}
        onChange={patch => { touchedRef.current = true; setVatDraft(d => ({ ...d, ...patch })); }}
        legalForm={pendingLegalForm ?? savedLegalForm}
        onSave={async patch => { await save(patch); next(); }} />;
      break;
    case 'huisstijl':
      content = <BrandStep {...common}
        draft={brandDraft}
        onChange={patch => { touchedRef.current = true; setBrandDraft(d => ({ ...d, ...patch })); }}
        settings={settings}
        companyDraft={companyDraft}
        onSave={async () => {
          const before = brandDraftFrom(settings);
          if (before.logo !== brandDraft.logo || before.color !== brandDraft.color) {
            await save({ brand_logo_data_url: brandDraft.logo, brand_accent_color: brandDraft.color });
          }
          next();
        }}
        onSkip={() => next()} />;
      break;
    case 'facturen':
      content = <InvoicingStep {...common}
        draft={invoiceDraft}
        onChange={patch => { touchedRef.current = true; setInvoiceDraft(d => ({ ...d, ...patch })); }}
        iban={settings?.iban ?? null}
        mollieConnected={mollie ? mollie.status === 'connected' : null}
        onEditCompany={() => goTo('bedrijf')}
        onSave={async () => {
          if (!invoiceDraft.method) throw new Error('Kies hoe je je facturen wilt versturen.');
          await saveInvoiceSendMethod(organizationId, invoiceDraft.method);
          // Dit antwoord bevat ook de verzendwijze die net is opgeslagen.
          await save({ invoice_payment_terms: invoiceDraft.terms.trim() || null, invoice_footer: invoiceDraft.footer.trim() || null });
          next();
        }} />;
      break;
    case 'mollie':
      content = <MollieStep {...common}
        organizationId={organizationId}
        isOwner={isOwner}
        sendMethod={settings?.invoice_send_method ?? invoiceDraft.method}
        status={mollie}
        loadError={mollieLoadError}
        onConnected={status => setMollie(status)}
        onRefresh={refreshMollie}
        onNext={() => next()} />;
      break;
    case 'klaar':
    default:
      content = <DoneStep {...common}
        organization={organization}
        isChild={isChild}
        settings={settings}
        savedLegalForm={savedLegalForm}
        pendingLegalForm={pendingLegalForm}
        billing={billing}
        businessStatus={businessStatus}
        mollie={mollie}
        address={address}
        onGoTo={goTo}
        onFinish={async target => {
          const displayName = organizationDisplayName(settings?.company_name, settings?.trade_name);
          const done = await completeOrganizationOnboarding(organizationId, displayName);
          try { window.localStorage.removeItem(onboardingProgressKey(organizationId)); } catch { /* geen opslag */ }
          writeCheckoutFlag(organizationId, false);
          await props.onCompleted(target, done);
        }} />;
  }

  return <div className="onb" data-step={current.key}>
    <SetupRail
      organization={organization}
      displayName={organizationDisplayName(settings?.company_name, settings?.trade_name) || organization.name}
      organizations={props.organizations}
      steps={steps}
      current={current.key}
      completed={completedSet}
      reachable={reachable}
      required={pendingLegalForm ? ['abonnement'] : []}
      userEmail={userEmail}
      onGoTo={goTo}
      onSwitchOrganization={props.onSwitchOrganization}
      onSignOut={props.onSignOut}
    />
    <main className="onb-main" ref={mainRef}>
      {content}
    </main>
  </div>;
}

// ── De stappenlijst ─────────────────────────────────────────────────────────

function SetupRail({ organization, displayName, organizations, steps, current, completed, reachable, required, userEmail, onGoTo, onSwitchOrganization, onSignOut }: {
  organization: Organization;
  /** De naam van het bedrijf zodra die er is, anders die van de organisatie. */
  displayName: string;
  organizations: Organization[];
  steps: OnboardingStep[];
  current: OnboardingStepKey;
  completed: ReadonlySet<OnboardingStepKey>;
  reachable: ReadonlySet<OnboardingStepKey>;
  /** Stappen die nu niet optioneel zijn: het abonnement voor een gekozen bv. */
  required: OnboardingStepKey[];
  userEmail: string | null;
  onGoTo: (key: OnboardingStepKey) => void;
  onSwitchOrganization: (organizationId: string) => Promise<void>;
  onSignOut: () => void;
}) {
  const [switching, setSwitching] = useState(false);
  const index = steps.findIndex(step => step.key === current);
  const done = steps.filter(step => completed.has(step.key) && step.key !== 'klaar').length;
  const pct = Math.round((done / Math.max(1, steps.length - 1)) * 100);
  return <aside className="onb-rail" aria-label="Stappen">
    <div className="onb-brand">
      <span className="onb-brand-tile"><BrandMark size={30} /></span>
      <span className="onb-brand-name">ResoFly<small>Inrichten</small></span>
    </div>
    <div className="onb-rail-intro">
      <h2>Je organisatie inrichten</h2>
      <p title={displayName}>{displayName}</p>
    </div>
    <div className="onb-meter" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Voortgang">
      <span style={{ width: `${pct}%` }} />
    </div>
    <p className="onb-meter-text"><span>Stap {index + 1} van {steps.length}</span><span>{steps[index]?.title}</span></p>
    <ol className="onb-steps">
      {steps.map((step, i) => {
        const isCurrent = step.key === current;
        const isDone = completed.has(step.key) && !isCurrent;
        const canGo = reachable.has(step.key) && !isCurrent;
        return <li key={step.key} className={`onb-step${isCurrent ? ' is-current' : ''}${isDone ? ' is-done' : ''}${canGo ? '' : ' is-locked'}`}>
          <button type="button" onClick={() => canGo && onGoTo(step.key)} disabled={!canGo && !isCurrent} aria-current={isCurrent ? 'step' : undefined}>
            <span className="onb-step-dot" aria-hidden="true">{isDone ? <Check size={14} strokeWidth={3} /> : i + 1}</span>
            <span className="onb-step-text">
              <strong>{step.title}{step.optional && !required.includes(step.key) && <em>optioneel</em>}</strong>
              <small>{step.hint}</small>
            </span>
          </button>
        </li>;
      })}
    </ol>
    <div className="onb-rail-foot">
      {organizations.length > 1 && <label className="onb-switch">
        <span>Andere organisatie</span>
        <Select value={organization.id} disabled={switching} onChange={event => {
          const id = event.target.value;
          if (!id || id === organization.id) return;
          setSwitching(true);
          void onSwitchOrganization(id).finally(() => setSwitching(false));
        }}>
          {organizations.map(org => <option key={org.id} value={org.id}>{org.name}</option>)}
        </Select>
      </label>}
      <div className="onb-account">
        <span title={userEmail ?? undefined}>{userEmail ?? 'Ingelogd'}</span>
        <button type="button" onClick={onSignOut}><LogOut size={14} aria-hidden="true" /> Uitloggen</button>
      </div>
    </div>
  </aside>;
}

// ── Gedeelde opbouw van een stap ─────────────────────────────────────────────

interface StepCommon {
  stepNumber: number;
  stepCount: number;
  titleRef: RefObject<HTMLHeadingElement>;
  onBack: (() => void) | null;
}

function StepFrame({ stepNumber, stepCount, titleRef, eyebrow, title, lead, icon, children, footer }: StepCommon & {
  eyebrow?: string;
  title: ReactNode;
  lead?: ReactNode;
  icon?: ReactNode;
  children: ReactNode;
  footer: ReactNode;
}) {
  return <>
    <header className="onb-head">
      <p className="onb-eyebrow">{icon}<span>{eyebrow ?? `Stap ${stepNumber} van ${stepCount}`}</span></p>
      <h1 className="onb-title" ref={titleRef} tabIndex={-1}>{title}</h1>
      {lead && <p className="onb-lead">{lead}</p>}
    </header>
    <div className="onb-body">{children}</div>
    <footer className="onb-foot">{footer}</footer>
  </>;
}

function Footer({ onBack, primary, primaryLabel, busy, disabled, secondary }: {
  onBack: (() => void) | null;
  primary: () => void;
  primaryLabel: string;
  busy?: boolean;
  disabled?: boolean;
  secondary?: ReactNode;
}) {
  return <>
    <div className="onb-foot-left">
      {onBack && <button type="button" className="btn btn-ghost onb-back" onClick={onBack} disabled={busy}><ArrowLeft size={15} aria-hidden="true" /> Terug</button>}
    </div>
    <div className="onb-foot-right">
      {secondary}
      <button type="button" className="btn btn-primary onb-next" onClick={primary} disabled={busy || disabled}>
        {busy ? <Loader2 size={15} className="onb-spin" aria-hidden="true" /> : null}
        {busy ? 'Bezig…' : primaryLabel}
        {!busy && <ArrowRight size={15} aria-hidden="true" />}
      </button>
    </div>
  </>;
}

function Notice({ tone, children }: { tone: 'error' | 'ok' | 'warn' | 'info'; children: ReactNode }) {
  const icon = tone === 'error' || tone === 'warn' ? <AlertTriangle size={16} aria-hidden="true" /> : tone === 'ok' ? <CheckCircle2 size={16} aria-hidden="true" /> : <Sparkles size={16} aria-hidden="true" />;
  return <div className={`onb-notice is-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>{icon}<div>{children}</div></div>;
}

/** Voert een opslagactie uit met bezig-stand en foutmelding. */
function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (action: () => Promise<void>, fallback = 'Opslaan is niet gelukt.') => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(errorText(e, fallback));
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, setError, run };
}

// ── 1 · Welkom ──────────────────────────────────────────────────────────────

function WelcomeStep({ organization, isChild, steps, invitations, onAcceptInvitation, onNext, ...common }: StepCommon & {
  organization: Organization;
  isChild: boolean;
  steps: OnboardingStep[];
  invitations: OrganizationInvitation[];
  onAcceptInvitation: (id: string) => Promise<void>;
  onNext: () => void;
}) {
  const [accepting, setAccepting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const groups: Array<{ icon: ReactNode; title: string; text: string; keys: OnboardingStepKey[] }> = [
    { icon: <Scale size={20} />, title: 'Wie je bent', text: 'Rechtsvorm, bedrijfsgegevens en, bij een bv, de zakelijke module.', keys: ['rechtsvorm', 'abonnement', 'bedrijf'] },
    { icon: <Calculator size={20} />, title: 'Hoe je boekhoudt', text: 'Btw, de kleineondernemersregeling en je boekjaar.', keys: ['btw'] },
    { icon: <Receipt size={20} />, title: 'Hoe je factureert', text: 'Je huisstijl, per e-mail of via Mollie, en online betalen.', keys: ['huisstijl', 'facturen', 'mollie'] },
  ];
  return <StepFrame {...common}
    eyebrow="Welkom"
    icon={<Sparkles size={14} aria-hidden="true" />}
    title={<>Welkom bij <span className="onb-gold">ResoFly</span></>}
    lead={isChild
      ? <>We richten samen de administratie <strong>{organization.name}</strong> in. Dat kost een paar minuten. Elke stap wordt meteen bewaard: stop je tussendoor, dan ga je later verder waar je was.</>
      : 'We richten samen je organisatie in. Dat kost een minuut of vijf. Elke stap wordt meteen bewaard: stop je tussendoor, dan ga je later verder waar je was.'}
    footer={<Footer onBack={null} primary={onNext} primaryLabel="Beginnen" />}>
    {invitations.length > 0 && <section className="onb-card onb-invite">
      <div className="onb-card-head"><UserPlus size={18} aria-hidden="true" /><h3>Je bent uitgenodigd</h3></div>
      <p>Hoor je bij een team dat ResoFly al gebruikt? Accepteer dan de uitnodiging; die organisatie is al ingericht.</p>
      {error && <Notice tone="error">{error}</Notice>}
      <ul className="onb-list">
        {invitations.map(invitation => <li key={invitation.id}>
          <span>{invitation.email}<small>{invitation.role === 'accountant' ? 'als boekhouder' : 'als teamlid'}</small></span>
          <button type="button" className="btn btn-primary" disabled={accepting !== null} onClick={() => {
            setAccepting(invitation.id); setError(null);
            onAcceptInvitation(invitation.id).catch(e => { setError(errorText(e, 'Accepteren is niet gelukt.')); setAccepting(null); });
          }}>{accepting === invitation.id ? 'Bezig…' : 'Accepteren'}</button>
        </li>)}
      </ul>
    </section>}
    <div className="onb-route">
      {groups.map((group, i) => {
        const titles = steps.filter(step => group.keys.includes(step.key)).map(step => step.title);
        return <article key={group.title} className="onb-route-card" style={{ animationDelay: `${i * 70}ms` }}>
          <span className="onb-route-icon" aria-hidden="true">{group.icon}</span>
          <span className="onb-route-num" aria-hidden="true">{i + 1}</span>
          <h3>{group.title}</h3>
          <p>{group.text}</p>
          <small>{titles.join(' · ')}</small>
        </article>;
      })}
    </div>
    <div className="onb-facts">
      <span><ShieldCheck size={16} aria-hidden="true" /> Je gegevens blijven van jouw organisatie; niemand anders ziet ze.</span>
      <span><RefreshCw size={16} aria-hidden="true" /> Alles is later aan te passen bij Instellingen.</span>
      {isChild && <span><Layers size={16} aria-hidden="true" /> Dit is een extra administratie: het abonnement hoort bij de hoofdorganisatie, dus die stap sla je over.</span>}
    </div>
  </StepFrame>;
}

// ── 2 · Rechtsvorm ──────────────────────────────────────────────────────────

function LegalFormStep({ choice, onChoose, savedLegalForm, confirmed, businessStatus, isChild, onSave, ...common }: StepCommon & {
  choice: LegalForm | null;
  onChoose: (form: LegalForm) => void;
  savedLegalForm: LegalForm;
  /** De opgeslagen rechtsvorm is een keuze, geen standaardwaarde. */
  confirmed: boolean;
  businessStatus: OrganizationBusinessStatus | null;
  isChild: boolean;
  onSave: (form: LegalForm) => Promise<void>;
}) {
  const { busy, error, run } = useAction();
  const info = choice ? LEGAL_FORM_INFO[choice] : null;
  const moduleNeeded = Boolean(choice && needsBusinessModule(choice) && !businessStatus?.active && choice !== savedLegalForm);
  const price = businessStatus ? (businessStatus.billing_interval === 'year' ? businessStatus.addon_yearly_price_cents : businessStatus.addon_price_cents) : 0;
  const unit = businessStatus?.billing_interval === 'year' ? 'jaar' : 'maand';
  return <StepFrame {...common}
    icon={<Scale size={14} aria-hidden="true" />}
    title="Welke rechtsvorm heeft je bedrijf?"
    lead="De rechtsvorm bepaalt je rekeningschema, welke belasting je betaalt en welke schermen je in ResoFly ziet. Je vindt hem in je inschrijving bij de KvK."
    footer={<Footer onBack={common.onBack} busy={busy}
      primaryLabel={!choice ? 'Kies je rechtsvorm' : moduleNeeded && !isChild ? 'Verder naar abonnement' : 'Volgende'}
      disabled={!choice || (moduleNeeded && isChild)}
      primary={() => { if (choice) void run(() => onSave(choice), 'De rechtsvorm kon niet worden opgeslagen.'); }} />}>
    {error && <Notice tone="error">{error}</Notice>}
    {LEGAL_FORM_GROUPS.map(group => <section key={group.group} className="onb-group" aria-labelledby={`onb-group-${group.group}`}>
      <div className="onb-group-head">
        <h3 id={`onb-group-${group.group}`}>{group.title}</h3>
        <p>{group.text}</p>
      </div>
      <div className="onb-choices" role="radiogroup" aria-labelledby={`onb-group-${group.group}`}>
        {group.forms.map(form => {
          const formInfo = LEGAL_FORM_INFO[form];
          const on = form === choice;
          return <button key={form} type="button" role="radio" aria-checked={on} className={`onb-choice${on ? ' is-on' : ''}`} onClick={() => onChoose(form)}>
            <span className="onb-choice-check" aria-hidden="true">{on && <Check size={13} strokeWidth={3} />}</span>
            <strong>{formInfo.label}</strong>
            <span className="onb-choice-text">{formInfo.tagline}</span>
            <span className="onb-tags">
              <span className="onb-tag">{formInfo.tax}</span>
              {formInfo.needsBusinessModule && <span className="onb-tag is-gold">Zakelijke module</span>}
              {confirmed && form === savedLegalForm && <span className="onb-tag is-ok">Opgeslagen</span>}
            </span>
          </button>;
        })}
      </div>
    </section>)}

    {info && choice && <section className="onb-card onb-explain" aria-live="polite">
      <div className="onb-card-head"><BadgeCheck size={18} aria-hidden="true" /><h3>{info.label} in ResoFly</h3></div>
      <ul className="onb-bullets">{info.inResoFly.map(line => <li key={line}>{line}</li>)}</ul>
      {moduleNeeded && (isChild
        ? <Notice tone="warn">Voor een {info.label} is de zakelijke module nodig, en die staat bij de hoofdorganisatie niet aan. Zet hem daar aan bij Instellingen → Abonnement, of kies hier een andere rechtsvorm.</Notice>
        : <Notice tone="info">
          <strong>Hiervoor heb je de zakelijke module nodig</strong>{price > 0 ? <> ({eur(price)} per {unit}, bovenop je abonnement)</> : null}. Die zet je in de volgende stap aan. Tot dan blijft je administratie als {LEGAL_FORM_LABELS[savedLegalForm]} staan; ResoFly zet hem om zodra de module aan staat.
        </Notice>)}
    </section>}
    <p className="onb-small">Twijfel je? Kijk op je uittreksel van de KvK, of vraag het je boekhouder. Een verkeerde keuze pas je later aan bij Instellingen → Facturatie.</p>
  </StepFrame>;
}

// ── 3 · Abonnement en modules ────────────────────────────────────────────────

function PlanStep({ organizationId, billing, businessStatus, creativeStatus, pendingLegalForm, legalNotice, legalSaveError, onRetryLegalSave, onRefresh, onChangeLegalForm, onNext, ...common }: StepCommon & {
  organizationId: string;
  billing: OrganizationBillingOverview | null;
  businessStatus: OrganizationBusinessStatus | null;
  creativeStatus: OrganizationCreativeStatus | null;
  pendingLegalForm: LegalForm | null;
  legalNotice: string | null;
  legalSaveError: string | null;
  onRetryLegalSave: () => void;
  onRefresh: () => Promise<{ overview: OrganizationBillingOverview | null; business: OrganizationBusinessStatus | null }>;
  onChangeLegalForm: () => void;
  onNext: () => void;
}) {
  const [plans, setPlans] = useState<BillingPlan[] | null>(null);
  const [plansError, setPlansError] = useState<string | null>(null);
  const [planKey, setPlanKey] = useState<string>('');
  const [interval, setBillingInterval] = useState<'month' | 'year'>('month');
  const [withCreative, setWithCreative] = useState(false);
  const [mockPaymentId, setMockPaymentId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'business' | 'creative' | null>(null);
  const [waiting, setWaiting] = useState(() => readCheckoutFlag(organizationId));
  /** Na het wachten nog geen abonnement: afgebroken, of Mollie is laat. */
  const [notSeen, setNotSeen] = useState(false);
  const { busy, error, setError, run } = useAction();

  useEffect(() => {
    let alive = true;
    loadBillingPlans()
      .then(all => { if (alive) setPlans(getSelfServiceBillingPlans(all)); })
      .catch(e => { if (alive) setPlansError(errorText(e, 'De pakketten konden niet worden geladen.')); });
    return () => { alive = false; };
  }, []);

  const exempt = Boolean(billing?.billing_exempt);
  const hasSubscription = Boolean(billing?.mollie_subscription_id);
  const businessActive = Boolean(businessStatus?.active);
  const businessIncluded = Boolean(businessStatus?.included_in_plan);
  const creativeActive = Boolean(creativeStatus?.active);
  const creativeIncluded = Boolean(creativeStatus?.included_in_plan);

  useEffect(() => {
    if (!plans || planKey) return;
    const current = plans.find(plan => plan.plan_key === billing?.plan_key);
    setPlanKey((current ?? plans[0])?.plan_key ?? '');
  }, [plans, planKey, billing?.plan_key]);
  const plan = plans?.find(p => p.plan_key === planKey) ?? null;
  const hasYearly = Boolean(plan && plan.yearly_price_cents > 0);
  useEffect(() => { if (!hasYearly && interval === 'year') setBillingInterval('month'); }, [hasYearly, interval]);

  // Terug van de betaalpagina: de bevestiging van Mollie komt via een webhook,
  // vaak een paar seconden later. Even opnieuw kijken, en daarna stoppen.
  useEffect(() => {
    if (!waiting) return;
    if (hasSubscription) { writeCheckoutFlag(organizationId, false); setWaiting(false); setNotSeen(false); return; }
    let tries = 0;
    let stopped = false;
    const timer = window.setInterval(() => {
      tries += 1;
      void onRefresh().then(({ overview }) => {
        if (stopped) return;
        const seen = Boolean(overview?.mollie_subscription_id);
        if (seen || tries >= 12) {
          stopped = true;
          window.clearInterval(timer);
          writeCheckoutFlag(organizationId, false);
          setWaiting(false);
          setNotSeen(!seen);
        }
      });
    }, 4000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [waiting, hasSubscription, organizationId, onRefresh]);

  const planPrice = plan ? (interval === 'year' ? plan.yearly_price_cents : plan.monthly_price_cents) : 0;
  const creativePrice = plan ? ((interval === 'year' ? plan.creative_addon_yearly_price_cents : plan.creative_addon_price_cents) ?? 0) : 0;
  const businessPrice = businessStatus ? (businessStatus.billing_interval === 'year' ? businessStatus.addon_yearly_price_cents : businessStatus.addon_price_cents) : (plan?.business_addon_price_cents ?? 0);
  const unit = (billing?.billing_interval ?? interval) === 'year' ? 'jaar' : 'maand';
  const currency = plan?.currency ?? billing?.currency ?? 'EUR';

  async function startCheckout() {
    if (!plan) throw new Error('Kies een pakket.');
    setMockPaymentId(null);
    const result = await startSubscriptionCheckout(organizationId, plan.plan_key, interval, withCreative && creativePrice > 0);
    if (result.mock && result.providerPaymentId) { setMockPaymentId(result.providerPaymentId); return; }
    if (result.checkoutUrl) {
      // Alleen naar een echte betaalpagina (https). De URL komt van onze eigen
      // billing-functie, maar een adres dat we niet verwachten volgen we niet.
      const url = new URL(result.checkoutUrl, window.location.href);
      if (url.protocol !== 'https:' && url.origin !== window.location.origin) throw new Error('De betaalpagina van Mollie gaf een onverwacht adres. Probeer het opnieuw.');
      writeCheckoutFlag(organizationId, true);
      window.location.assign(url.href);
      return;
    }
    await onRefresh();
  }

  const needModule = Boolean(pendingLegalForm) && !businessActive;
  const stepOneDone = hasSubscription || exempt || businessIncluded;
  return <StepFrame {...common}
    icon={<Layers size={14} aria-hidden="true" />}
    title={needModule
      ? `Zet de zakelijke module aan voor je ${LEGAL_FORM_LABELS[pendingLegalForm as LegalForm]}`
      : hasSubscription || exempt ? 'Je pakket en modules' : 'Kies je pakket'}
    lead={exempt
      ? 'Deze organisatie is vrijgesteld van kosten: alle modules staan voor je aan.'
      : hasSubscription
        ? 'Je abonnement loopt. Hieronder zet je modules aan of uit; het bedrag past zich aan.'
        : needModule
          ? 'Boekhouden voor een bv, nv of coöperatie hoort bij de zakelijke module. Die zet je aan op een lopend abonnement: eerst het abonnement starten, dan de module.'
          : 'Je kunt ResoFly nu gewoon gebruiken. Wil je meteen een abonnement, kies dan hier je pakket; anders kan dat later bij Instellingen → Abonnement.'}
    footer={<Footer onBack={common.onBack} busy={busy}
      primaryLabel={needModule ? 'Volgende' : hasSubscription || exempt ? 'Volgende' : 'Later beslissen'}
      disabled={needModule}
      primary={onNext}
      secondary={needModule ? <button type="button" className="btn btn-ghost" onClick={onChangeLegalForm} disabled={busy}>Andere rechtsvorm</button> : undefined} />}>
    {error && <Notice tone="error">{error}</Notice>}
    {legalSaveError && <Notice tone="error">{legalSaveError} <button type="button" className="onb-link" onClick={onRetryLegalSave}>Opnieuw proberen</button></Notice>}
    {legalNotice && <Notice tone="ok">{legalNotice}</Notice>}
    {waiting && !hasSubscription && <Notice tone="info">
      <strong>Je betaling wordt verwerkt.</strong> Mollie laat ResoFly weten dat er betaald is; dat duurt meestal een paar seconden. <button type="button" className="onb-link" onClick={() => void onRefresh()}>Nu opnieuw kijken</button>
    </Notice>}
    {notSeen && !hasSubscription && <Notice tone="warn">
      We zien nog geen betaling. Heb je de betaling afgebroken, start het abonnement dan opnieuw. Heb je wel betaald, kijk dan over een minuut nog eens. <button type="button" className="onb-link" onClick={() => void onRefresh().then(({ overview }) => setNotSeen(!overview?.mollie_subscription_id))}>Opnieuw kijken</button>
    </Notice>}

    {needModule && <section className="onb-card onb-checklist">
      <div className="onb-card-head"><Building2 size={18} aria-hidden="true" /><h3>Zo zet je je {LEGAL_FORM_LABELS[pendingLegalForm as LegalForm]} vast</h3></div>
      <ol>
        <li className={stepOneDone ? 'is-done' : 'is-now'}>
          <span aria-hidden="true">{stepOneDone ? <Check size={13} strokeWidth={3} /> : 1}</span>
          <div><strong>Abonnement starten</strong><small>{stepOneDone ? 'Klaar.' : 'Kies hieronder je pakket en betaal de eerste keer via Mollie.'}</small></div>
        </li>
        <li className={businessActive ? 'is-done' : stepOneDone ? 'is-now' : ''}>
          <span aria-hidden="true">{businessActive ? <Check size={13} strokeWidth={3} /> : 2}</span>
          <div><strong>Zakelijke module aanzetten</strong><small>{businessPrice > 0 ? `${eur(businessPrice, currency)} per ${unit}. ` : ''}Rekeningschema voor een bv, vennootschapsbelasting, dga en jaarrekening.</small></div>
        </li>
        <li className={businessActive ? 'is-now' : ''}>
          <span aria-hidden="true">3</span>
          <div><strong>Rechtsvorm vastleggen</strong><small>Gaat vanzelf zodra de module aan staat.</small></div>
        </li>
      </ol>
    </section>}

    {/* Nog geen abonnement: kiezen en betalen. */}
    {!exempt && !hasSubscription && <section className="onb-card">
      <div className="onb-card-head"><CreditCard size={18} aria-hidden="true" /><h3>Pakket kiezen</h3></div>
      {plansError && <Notice tone="error">{plansError}</Notice>}
      {!plans && !plansError && <p className="onb-small">Pakketten laden…</p>}
      {plans && plans.length === 0 && <p className="onb-small">Er zijn nu geen pakketten te kiezen. Neem contact op met ResoFly.</p>}
      {plans && plans.length > 0 && <>
        <div className="onb-choices is-plans" role="radiogroup" aria-label="Pakket">
          {plans.map(p => {
            const on = p.plan_key === planKey;
            const seats = p.included_seats ?? Number(p.limits?.included_seats ?? 1);
            const storage = Number(p.limits?.storage_gb ?? 0);
            return <button key={p.plan_key} type="button" role="radio" aria-checked={on} className={`onb-choice onb-plan${on ? ' is-on' : ''}`} onClick={() => setPlanKey(p.plan_key)}>
              <span className="onb-choice-check" aria-hidden="true">{on && <Check size={13} strokeWidth={3} />}</span>
              <strong>{p.name}</strong>
              <span className="onb-price">{eur(interval === 'year' && p.yearly_price_cents > 0 ? p.yearly_price_cents : p.monthly_price_cents, p.currency)}<small>/{interval === 'year' && p.yearly_price_cents > 0 ? 'jaar' : 'maand'}</small></span>
              {p.description && <span className="onb-choice-text">{p.description}</span>}
              <span className="onb-tags">
                <span className="onb-tag">{seats === 1 ? '1 gebruiker' : `${seats} gebruikers`}</span>
                {storage > 0 && <span className="onb-tag">{storage >= 1000 ? `${storage / 1000} TB` : `${storage} GB`} opslag</span>}
                {billing?.plan_key === p.plan_key && <span className="onb-tag is-ok">Huidig</span>}
              </span>
            </button>;
          })}
        </div>
        <div className="onb-row">
          {hasYearly && <div className="onb-seg" role="radiogroup" aria-label="Betalen per">
            <button type="button" role="radio" aria-checked={interval === 'month'} className={interval === 'month' ? 'is-on' : ''} onClick={() => setBillingInterval('month')}>Per maand</button>
            <button type="button" role="radio" aria-checked={interval === 'year'} className={interval === 'year' ? 'is-on' : ''} onClick={() => setBillingInterval('year')}>Per jaar</button>
          </div>}
          {creativePrice > 0 && !creativeIncluded && <label className="onb-check">
            <input type="checkbox" checked={withCreative} onChange={event => setWithCreative(event.target.checked)} />
            <span>Creatieve module erbij: galerijen met foto's en video's voor je klanten · {eur(creativePrice, currency)} per {interval === 'year' ? 'jaar' : 'maand'}</span>
          </label>}
        </div>
        <div className="onb-total">
          <span>Je betaalt <strong>{eur(planPrice + (withCreative && !creativeIncluded ? creativePrice : 0), currency)}</strong> per {interval === 'year' ? 'jaar' : 'maand'}{needModule && businessPrice > 0 ? <>, en daarna {eur(businessPrice, currency)} voor de zakelijke module</> : null}.</span>
          <button type="button" className="btn btn-primary" disabled={busy || !plan} onClick={() => void run(startCheckout, 'Het abonnement kon niet worden gestart.')}>
            <Lock size={14} aria-hidden="true" /> Abonnement starten
          </button>
        </div>
        <p className="onb-small">Je betaalt de eerste keer op de beveiligde pagina van Mollie (iDEAL, creditcard en meer). Daarna loopt het automatisch. Opzeggen of wisselen kan bij Instellingen → Abonnement.</p>
        {mockPaymentId && <Notice tone="info">
          Testomgeving: er is geen echte betaling. <button type="button" className="onb-link" disabled={busy} onClick={() => void run(async () => {
            await markMockPaymentPaid(organizationId, mockPaymentId);
            setMockPaymentId(null);
            await onRefresh();
          }, 'De testbetaling kon niet worden afgerond.')}>Testbetaling afronden</button>
        </Notice>}
      </>}
    </section>}

    {/* Wel een abonnement (of vrijgesteld): de modules. */}
    {(hasSubscription || exempt) && <section className="onb-card">
      <div className="onb-card-head"><BadgeCheck size={18} aria-hidden="true" /><h3>{exempt ? 'Je modules' : `Je pakket: ${billing?.plan_name ?? ''}`}</h3></div>
      <div className="onb-modules">
        <ModuleRow
          title="Zakelijke module"
          text="Boekhouden voor een bv, nv of coöperatie: vennootschapsbelasting, dga, aandeelhouders en jaarrekening. Ook voor een holding met een werk-bv."
          active={businessActive}
          included={businessIncluded}
          price={businessPrice > 0 ? `${eur(businessPrice, currency)} per ${unit}` : null}
          highlight={needModule}
          busy={busy}
          confirming={confirm === 'business'}
          onAsk={() => { setError(null); setConfirm('business'); }}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void run(async () => {
            await setBusinessAddon(organizationId, true);
            setConfirm(null);
            await onRefresh();
          }, 'De zakelijke module kon niet worden aangezet.')}
        />
        <ModuleRow
          title="Creatieve module"
          text="Galerijen bij je projecten: foto's en video's in volle resolutie naar je klant, met favorieten en downloaden."
          active={creativeActive}
          included={creativeIncluded}
          price={(() => { const c = creativeStatus ? (creativeStatus.billing_interval === 'year' ? creativeStatus.addon_yearly_price_cents : creativeStatus.addon_price_cents) : 0; return c > 0 ? `${eur(c, currency)} per ${unit}` : null; })()}
          highlight={false}
          busy={busy}
          confirming={confirm === 'creative'}
          onAsk={() => { setError(null); setConfirm('creative'); }}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void run(async () => {
            await setCreativeAddon(organizationId, true);
            setConfirm(null);
            await onRefresh();
          }, 'De creatieve module kon niet worden aangezet.')}
        />
      </div>
    </section>}
    {needModule && <p className="onb-small">Wil je de zakelijke module niet? Kies dan een andere rechtsvorm. Boekhouden als bv kan in ResoFly alleen met deze module.</p>}
  </StepFrame>;
}

function ModuleRow({ title, text, active, included, price, highlight, busy, confirming, onAsk, onCancel, onConfirm }: {
  title: string;
  text: string;
  active: boolean;
  included: boolean;
  price: string | null;
  highlight: boolean;
  busy: boolean;
  confirming: boolean;
  onAsk: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return <div className={`onb-module${highlight && !active ? ' is-highlight' : ''}`}>
    <div>
      <strong>{title}</strong>
      <p>{text}</p>
      {confirming && <p className="onb-confirm-text">Je abonnement wordt {price ?? 'iets'} duurder. Aanzetten?</p>}
    </div>
    <div className="onb-module-act">
      {active
        ? <span className="onb-tag is-ok"><Check size={12} strokeWidth={3} aria-hidden="true" /> {included ? 'Inbegrepen' : 'Aan'}</span>
        : confirming
          ? <><button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>Annuleren</button><button type="button" className="btn btn-primary" onClick={onConfirm} disabled={busy}>{busy ? 'Bezig…' : 'Ja, aanzetten'}</button></>
          : <>{price && <small>{price}</small>}<button type="button" className={`btn ${highlight ? 'btn-primary' : 'btn-ghost'}`} onClick={onAsk} disabled={busy}>Aanzetten</button></>}
    </div>
  </div>;
}

// ── 4 · Bedrijfsgegevens ────────────────────────────────────────────────────

const COUNTRIES = ['Nederland', 'België', 'Duitsland', 'Luxemburg', 'Frankrijk', 'Verenigd Koninkrijk', 'Spanje', 'Italië', 'Oostenrijk', 'Ierland', 'Denemarken', 'Zweden', 'Zwitserland'];

function CompanyStep({ draft, onChange, legalForm, korEnabled, onSave, ...common }: StepCommon & {
  draft: CompanyDraft;
  onChange: (patch: Partial<CompanyDraft>) => void;
  legalForm: LegalForm;
  korEnabled: boolean;
  onSave: () => Promise<void>;
}) {
  const { busy, error, run } = useAction();
  const [showErrors, setShowErrors] = useState(false);
  const check = useMemo(() => checkCompanyDraft(draft, legalForm, { korEnabled }), [draft, legalForm, korEnabled]);
  const errorCount = Object.keys(check.errors).length;
  const info = LEGAL_FORM_INFO[legalForm];
  const customCountry = !COUNTRIES.includes(draft.country);

  const field = (key: CompanyField, label: string, options: { required?: boolean; hint?: string; placeholder?: string; span?: 2 | 3 | 4 | 6; type?: string; autoComplete?: string; inputMode?: 'text' | 'email' | 'tel' | 'url' | 'numeric' } = {}) => {
    const id = `onb-f-${key}`;
    const fieldError = showErrors ? check.errors[key] : undefined;
    const describedBy = [options.hint ? `${id}-hint` : '', fieldError ? `${id}-err` : ''].filter(Boolean).join(' ') || undefined;
    return <div className={`onb-field span-${options.span ?? 6}${fieldError ? ' has-error' : ''}`}>
      <label htmlFor={id}>{label}{options.required && <span className="onb-req" aria-hidden="true"> *</span>}</label>
      <Input id={id} value={draft[key]} type={options.type ?? 'text'} inputMode={options.inputMode} autoComplete={options.autoComplete}
        placeholder={options.placeholder} aria-invalid={fieldError ? true : undefined} aria-describedby={describedBy} aria-required={options.required || undefined}
        onChange={event => onChange({ [key]: event.target.value } as Partial<CompanyDraft>)} />
      {options.hint && <small id={`${id}-hint`}>{options.hint}</small>}
      {fieldError && <p id={`${id}-err`} className="onb-field-error">{fieldError}</p>}
    </div>;
  };

  return <StepFrame {...common}
    icon={<Building2 size={14} aria-hidden="true" />}
    title="Je bedrijfsgegevens"
    lead="Dit komt op je offertes en facturen, precies zoals je het hier invult. Naam en adres zijn verplicht op een factuur."
    footer={<Footer onBack={common.onBack} busy={busy} primaryLabel="Opslaan en verder"
      primary={() => {
        setShowErrors(true);
        if (errorCount > 0) {
          window.requestAnimationFrame(() => document.querySelector<HTMLElement>('.onb-field.has-error input')?.focus());
          return;
        }
        void run(onSave, 'Je bedrijfsgegevens konden niet worden opgeslagen.');
      }} />}>
    {error && <Notice tone="error">{error}</Notice>}
    {showErrors && errorCount > 0 && <Notice tone="error">Nog {errorCount === 1 ? 'één veld' : `${errorCount} velden`} om naar te kijken; ze staan in het rood.</Notice>}

    <section className="onb-card">
      <div className="onb-card-head"><Building2 size={18} aria-hidden="true" /><h3>Je bedrijf</h3></div>
      <div className="onb-fields">
        {field('company_name', legalForm === 'eenmanszaak' ? 'Bedrijfsnaam' : 'Statutaire naam', { required: true, placeholder: info.nameExample, hint: 'Zoals hij bij de KvK staat.', span: 3, autoComplete: 'organization' })}
        {field('trade_name', 'Handelsnaam', { placeholder: 'Leeg = de bedrijfsnaam', hint: 'De naam waaronder je klanten je kennen. Ook de naam in ResoFly.', span: 3 })}
      </div>
    </section>

    <section className="onb-card">
      <div className="onb-card-head"><Landmark size={18} aria-hidden="true" /><h3>Adres</h3></div>
      <div className="onb-fields">
        {field('address_line1', 'Straat en huisnummer', { required: true, placeholder: 'Kerkstraat 12', span: 4, autoComplete: 'address-line1' })}
        {field('address_line2', 'Toevoeging', { placeholder: 'Unit 3', span: 2, autoComplete: 'address-line2' })}
        {field('postal_code', 'Postcode', { required: true, placeholder: '3411 AB', span: 2, autoComplete: 'postal-code' })}
        {field('city', 'Plaats', { required: true, placeholder: 'Lopik', span: 2, autoComplete: 'address-level2' })}
        <div className="onb-field span-2">
          <label htmlFor="onb-f-country">Land<span className="onb-req" aria-hidden="true"> *</span></label>
          <Select id="onb-f-country" value={customCountry ? '__anders' : draft.country} onChange={event => onChange({ country: event.target.value === '__anders' ? '' : event.target.value })}>
            {COUNTRIES.map(country => <option key={country} value={country}>{country}</option>)}
            <option value="__anders">Ander land…</option>
          </Select>
          {customCountry && <Input aria-label="Land" value={draft.country} placeholder="Land" onChange={event => onChange({ country: event.target.value })} />}
          {showErrors && check.errors.country && <p className="onb-field-error">{check.errors.country}</p>}
        </div>
      </div>
    </section>

    <section className="onb-card">
      <div className="onb-card-head"><Mail size={18} aria-hidden="true" /><h3>Contact</h3></div>
      <div className="onb-fields">
        {field('email', 'E-mailadres', { required: true, type: 'email', inputMode: 'email', placeholder: 'info@studiojansen.nl', hint: 'Staat op je facturen; je klanten mailen hiernaartoe terug.', span: 6, autoComplete: 'email' })}
        {field('phone', 'Telefoon', { type: 'tel', inputMode: 'tel', placeholder: '0348 123 456', span: 3, autoComplete: 'tel' })}
        {field('website', 'Website', { inputMode: 'url', placeholder: 'studiojansen.nl', span: 3, autoComplete: 'url' })}
      </div>
    </section>

    <section className="onb-card">
      <div className="onb-card-head"><BadgeCheck size={18} aria-hidden="true" /><h3>Registratie en bank</h3></div>
      <div className="onb-fields">
        {field('kvk_number', 'KvK-nummer', { inputMode: 'numeric', placeholder: '12345678', span: 2 })}
        {field('vat_number', 'Btw-id', { placeholder: 'NL123456789B01', span: 2, hint: legalForm === 'eenmanszaak' ? 'Je btw-identificatienummer, niet je omzetbelastingnummer.' : undefined })}
        {field('iban', 'IBAN', { placeholder: 'NL91 ABNA 0417 1643 00', span: 2, autoComplete: 'off', hint: 'Waar je klanten naar overmaken.' })}
      </div>
    </section>

    {check.notes.length > 0 && <div className="onb-hints">
      {check.notes.map(note => <p key={note}><Sparkles size={14} aria-hidden="true" />{note}</p>)}
    </div>}
  </StepFrame>;
}

// ── Je webadres ─────────────────────────────────────────────────────────────

/**
 * Het adres voor je klanten: <naam>.resofly.com (migratie 20261108230000).
 * Verplicht: elke mail aan een klant linkt ernaar, en de database rondt de
 * inrichting niet af zonder (complete_organization_onboarding). Terwijl je
 * typt, zegt het scherm of de naam al bestaat.
 */
function AddressStep({ organizationId, overview, loadError, onRetry, suggestion, onSaved, ...common }: StepCommon & {
  organizationId: string;
  overview: ClientDomainsOverview | null;
  loadError: string | null;
  onRetry: () => Promise<void>;
  suggestion: string;
  onSaved: () => Promise<void>;
}) {
  const { busy, error, setError, run } = useAction();
  const current = overview?.subdomain?.name ?? null;
  const [name, setName] = useState<string>(() => current ?? suggestion);
  const [picker, setPicker] = useState<AddressPickerState | null>(null);
  // Komt het overzicht later binnen (een eerder gekozen naam), dan die tonen
  // zolang er nog niets getypt is.
  const touched = useRef(false);
  useEffect(() => { if (!touched.current && current) setName(current); }, [current]);

  const base = overview?.config.base ?? null;
  const isCurrent = Boolean(current && picker?.name === current && picker.check?.status === 'own');
  const ready = Boolean(picker && !picker.checking && (isCurrent || canClaim(picker.check)));

  async function save() {
    if (!picker) return;
    if (isCurrent) { await onSaved(); return; }
    if (!canClaim(picker.check)) throw new Error('Kies een naam die nog vrij is.');
    await claimClientSubdomain(organizationId, picker.name);
    await onSaved();
  }

  return <StepFrame {...common}
    icon={<Globe size={14} aria-hidden="true" />}
    title="Je webadres"
    lead="Op dit adres openen je klanten hun albums, offertes, facturen, contracten en het klantportaal. Elke mail aan een klant linkt ernaar, dus kies een naam die bij je bedrijf past. Je kunt hem later nog wijzigen."
    footer={<Footer onBack={common.onBack} busy={busy} primaryLabel="Opslaan en verder" disabled={!ready}
      primary={() => void run(save, 'Het webadres kon niet worden vastgelegd.')} />}>
    {error && <Notice tone="error">{error}</Notice>}
    {loadError && !overview && <Notice tone="error">
      {loadError} <button type="button" className="onb-link" onClick={() => { setError(null); void onRetry(); }}>Opnieuw proberen</button>
    </Notice>}
    {!overview && !loadError && <p className="onb-small"><Loader2 size={14} className="onb-spin" aria-hidden="true" /> Even laden…</p>}
    {overview && base && <section className="onb-card onb-address">
      <div className="onb-card-head"><Globe size={18} aria-hidden="true" /><h3>Kies je naam</h3></div>
      <label className="onb-address-label" htmlFor="onb-f-address">Je adres</label>
      <ClientAddressPicker
        id="onb-f-address"
        organizationId={organizationId}
        base={base}
        value={name}
        disabled={busy}
        onChange={state => { touched.current = true; setName(state.name); setPicker(state); setError(null); }}
      />
      <div className="onb-address-preview" aria-label="Zo ziet je klant het">
        <span className="onb-address-lock" aria-hidden="true"><Lock size={12} /></span>
        <span className="onb-address-url"><strong>{(picker?.name || name || 'jouwnaam')}.{base}</strong>/portal</span>
      </div>
      <p className="onb-small">Een eigen domein voor je albums en facturen, zoals albums.jouwbedrijf.nl, kun je later koppelen bij Instellingen → Domein.</p>
    </section>}
  </StepFrame>;
}

// ── 5 · Btw en boekhouding ──────────────────────────────────────────────────

function VatStep({ draft, onChange, legalForm, onSave, ...common }: StepCommon & {
  draft: VatDraft;
  onChange: (patch: Partial<VatDraft>) => void;
  legalForm: LegalForm;
  onSave: (patch: OnboardingSettingsPatch) => Promise<void>;
}) {
  const { busy, error, setError, run } = useAction();
  const calendarOnly = fiscalYearMustBeCalendarYear(legalForm);
  const suggestions = useMemo(() => bookkeepingStartSuggestions(new Date()), []);
  const fiscalMonth = calendarOnly ? 1 : draft.fiscalMonth;
  return <StepFrame {...common}
    icon={<Calculator size={14} aria-hidden="true" />}
    title="Btw en boekhouding"
    lead="Zo weet ResoFly welke btw er op je facturen komt, wanneer je aangifte doet en waar je boekjaar begint."
    footer={<Footer onBack={common.onBack} busy={busy} primaryLabel="Opslaan en verder"
      primary={() => {
        const rate = parseHourlyRateCents(draft.hourlyRate);
        if (rate === undefined) { setError('Vul het uurtarief in als bedrag, bijvoorbeeld 85 of 85,50.'); return; }
        if (draft.startDate && !isIsoDate(draft.startDate)) { setError('Kies een geldige startdatum, of laat hem leeg.'); return; }
        void run(() => onSave({
          kor_enabled: draft.kor,
          vat_return_period: draft.period,
          fiscal_year_start_month: fiscalMonth,
          bookkeeping_start_date: draft.startDate || null,
          default_hourly_rate_cents: rate,
          year_result_account_code: defaultYearResultAccount(legalForm),
        }), 'De instellingen konden niet worden opgeslagen.');
      }} />}>
    {error && <Notice tone="error">{error}</Notice>}

    <section className="onb-card">
      <div className="onb-card-head"><Receipt size={18} aria-hidden="true" /><h3>Reken je btw?</h3></div>
      <div className="onb-choices is-two" role="radiogroup" aria-label="Btw">
        <button type="button" role="radio" aria-checked={!draft.kor} className={`onb-choice${!draft.kor ? ' is-on' : ''}`} onClick={() => onChange({ kor: false })}>
          <span className="onb-choice-check" aria-hidden="true">{!draft.kor && <Check size={13} strokeWidth={3} />}</span>
          <strong>Ja, ik reken btw</strong>
          <span className="onb-choice-text">De gewone situatie. Je facturen krijgen btw, je doet aangifte en je trekt de btw op je inkopen af.</span>
        </button>
        <button type="button" role="radio" aria-checked={draft.kor} className={`onb-choice${draft.kor ? ' is-on' : ''}`} onClick={() => onChange({ kor: true })}>
          <span className="onb-choice-check" aria-hidden="true">{draft.kor && <Check size={13} strokeWidth={3} />}</span>
          <strong>Nee, ik gebruik de KOR</strong>
          <span className="onb-choice-text">De kleineondernemersregeling: minder dan € 20.000 omzet per jaar. Geen btw op je facturen en geen aangifte, maar ook geen btw terug. Je meldt je er zelf voor aan bij de Belastingdienst.</span>
        </button>
      </div>
    </section>

    {!draft.kor && <section className="onb-card">
      <div className="onb-card-head"><CalendarDays size={18} aria-hidden="true" /><h3>Btw-aangifte</h3></div>
      <div className="onb-seg" role="radiogroup" aria-label="Btw-aangifte">
        {(Object.keys(VAT_PERIOD_LABELS) as VatReturnPeriodType[]).map(period => <button key={period} type="button" role="radio" aria-checked={draft.period === period} className={draft.period === period ? 'is-on' : ''} onClick={() => onChange({ period })}>{VAT_PERIOD_LABELS[period]}</button>)}
      </div>
      <p className="onb-small">De meeste ondernemers doen per kwartaal aangifte. Per maand alleen als de Belastingdienst je dat heeft gevraagd, of als je vaak btw terugkrijgt.</p>
    </section>}

    <section className="onb-card">
      <div className="onb-card-head"><Calculator size={18} aria-hidden="true" /><h3>Boekjaar en start</h3></div>
      <div className="onb-fields">
        <div className="onb-field span-3">
          <label htmlFor="onb-f-fiscal">Boekjaar begint in</label>
          <Select id="onb-f-fiscal" value={fiscalMonth} disabled={calendarOnly} onChange={event => onChange({ fiscalMonth: Number(event.target.value) })}>
            {MONTH_NAMES.map((month, i) => <option key={month} value={i + 1}>{month[0].toUpperCase() + month.slice(1)}</option>)}
          </Select>
          <small>{calendarOnly
            ? `Voor een ${LEGAL_FORM_LABELS[legalForm].toLowerCase()} is het boekjaar altijd het kalenderjaar.`
            : 'Meestal januari. Een andere maand alleen als dat in je statuten staat (een gebroken boekjaar).'}</small>
        </div>
        <div className="onb-field span-3">
          <label htmlFor="onb-f-start">Boekhouding in ResoFly vanaf</label>
          <Input id="onb-f-start" type="date" value={draft.startDate} onChange={event => onChange({ startDate: event.target.value })} />
          <div className="onb-chips">
            {suggestions.map(option => <button key={option.value} type="button" className={`onb-chip${draft.startDate === option.value ? ' is-on' : ''}`} onClick={() => onChange({ startDate: option.value })}>{option.label}</button>)}
          </div>
          <small>Facturen van vóór deze datum komen niet in je grootboek; die stand zit in je beginbalans. Net begonnen? Kies de dag dat je startte.</small>
        </div>
        <div className="onb-field span-3">
          <label htmlFor="onb-f-rate">Standaard uurtarief</label>
          <div className="onb-input-prefix"><span aria-hidden="true">€</span><Input id="onb-f-rate" inputMode="decimal" value={draft.hourlyRate} placeholder="Bijvoorbeeld 85" onChange={event => onChange({ hourlyRate: event.target.value })} /></div>
          <small>Optioneel. Voor de waarde van je uren als een project geen eigen tarief heeft.</small>
        </div>
      </div>
    </section>
  </StepFrame>;
}

// ── 6 · Huisstijl ───────────────────────────────────────────────────────────

function BrandStep({ draft, onChange, settings, companyDraft, onSave, onSkip, ...common }: StepCommon & {
  draft: BrandDraft;
  onChange: (patch: Partial<BrandDraft>) => void;
  settings: CompanySettings | null;
  companyDraft: CompanyDraft;
  onSave: () => Promise<void>;
  onSkip: () => void;
}) {
  const { busy, error, setError, run } = useAction();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [reading, setReading] = useState(false);
  const name = companyDraft.trade_name.trim() || companyDraft.company_name.trim() || settings?.company_name || 'Je bedrijf';
  const onAccent = textOnColor(draft.color);
  async function pick(file: File | undefined) {
    if (!file) return;
    setError(null);
    setReading(true);
    try {
      onChange({ logo: await logoToDataUrl(file) });
    } catch (e) {
      setError(errorText(e, 'Dit logo kon niet worden gelezen.'));
    } finally {
      setReading(false);
    }
  }
  const address = [companyDraft.address_line1, [companyDraft.postal_code, companyDraft.city].filter(Boolean).join(' ')].filter(s => s.trim()).join(' · ');
  return <StepFrame {...common}
    icon={<Palette size={14} aria-hidden="true" />}
    title="Je huisstijl"
    lead="Je logo en je kleur komen op je offertes, facturen, e-mails en in het klantportaal. Meer instellen, zoals lettertypen, kan later bij Instellingen → Huisstijl."
    footer={<Footer onBack={common.onBack} busy={busy || reading} primaryLabel="Opslaan en verder"
      primary={() => void run(onSave, 'Je huisstijl kon niet worden opgeslagen.')}
      secondary={<button type="button" className="btn btn-ghost" onClick={onSkip} disabled={busy}>Overslaan</button>} />}>
    {error && <Notice tone="error">{error}</Notice>}
    <div className="onb-brand-grid">
      <section className="onb-card">
        <div className="onb-card-head"><Upload size={18} aria-hidden="true" /><h3>Logo</h3></div>
        <div className="onb-logo">
          <div className="onb-logo-preview">{draft.logo ? <img src={draft.logo} alt="Je logo" /> : <span>Nog geen logo</span>}</div>
          <div className="onb-logo-actions">
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={event => { void pick(event.target.files?.[0]); event.target.value = ''; }} />
            <button type="button" className="btn btn-ghost" onClick={() => fileRef.current?.click()} disabled={reading}>{reading ? 'Lezen…' : draft.logo ? 'Ander logo' : 'Logo kiezen'}</button>
            {draft.logo && <button type="button" className="btn btn-ghost" onClick={() => onChange({ logo: null })}><Trash2 size={14} aria-hidden="true" /> Weghalen</button>}
            <small>PNG, JPEG of WebP, het liefst met een doorzichtige achtergrond.</small>
          </div>
        </div>
        <div className="onb-card-head is-sub"><Palette size={18} aria-hidden="true" /><h3>Merkkleur</h3></div>
        <div className="onb-swatches" role="radiogroup" aria-label="Merkkleur">
          {BRAND_COLORS.map(color => <button key={color} type="button" role="radio" aria-checked={draft.color === color} aria-label={color}
            className={`onb-swatch${draft.color === color ? ' is-on' : ''}`} style={{ background: color }} onClick={() => onChange({ color })} />)}
          <label className="onb-swatch is-custom" title="Eigen kleur">
            <input type="color" value={draft.color} aria-label="Eigen kleur" onChange={event => /^#[0-9a-f]{6}$/i.test(event.target.value) && onChange({ color: event.target.value.toUpperCase() })} />
          </label>
        </div>
      </section>

      <section className="onb-paper" aria-label="Voorbeeld van je factuur">
        <div className="onb-paper-top" style={{ borderColor: draft.color }}>
          {draft.logo ? <img src={draft.logo} alt="" /> : <strong style={{ color: draft.color }}>{name}</strong>}
          <span className="onb-paper-kind">Factuur</span>
        </div>
        <div className="onb-paper-meta"><span>Factuur 2026-001</span><span>{new Date().toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' })}</span></div>
        <div className="onb-paper-lines">
          <div><span>Ontwerp en advies</span><span>€ 850,00</span></div>
          <div><span>Drukwerk</span><span>€ 240,00</span></div>
          <div className="is-total" style={{ background: draft.color, color: onAccent }}><span>Totaal</span><span>€ 1.318,90</span></div>
        </div>
        <div className="onb-paper-foot">
          <strong>{name}</strong>
          <span>{address || 'Je adres'}</span>
          <span>{[companyDraft.kvk_number && `KvK ${companyDraft.kvk_number}`, companyDraft.vat_number && `Btw ${companyDraft.vat_number}`, companyDraft.iban && `IBAN ${companyDraft.iban}`].filter(Boolean).join(' · ') || 'KvK · Btw · IBAN'}</span>
        </div>
      </section>
    </div>
  </StepFrame>;
}

// ── 7 · Facturen versturen ─────────────────────────────────────────────────

function InvoicingStep({ draft, onChange, iban, mollieConnected, onEditCompany, onSave, ...common }: StepCommon & {
  draft: InvoiceDraft;
  onChange: (patch: Partial<InvoiceDraft>) => void;
  iban: string | null;
  mollieConnected: boolean | null;
  onEditCompany: () => void;
  onSave: () => Promise<void>;
}) {
  const { busy, error, run } = useAction();
  const option = (method: InvoiceSendMethod, icon: ReactNode, title: string, text: string, points: string[]) => {
    const on = draft.method === method;
    return <button type="button" role="radio" aria-checked={on} className={`onb-choice onb-method${on ? ' is-on' : ''}`} onClick={() => {
      // Een betaaltekst die we zelf voorstelden, past mee met de keuze.
      const ours = PAYMENT_TERM_DAYS.find(days => draft.terms === paymentTermsText(days, draft.method));
      onChange({ method, ...(ours ? { terms: paymentTermsText(ours, method) } : {}) });
    }}>
      <span className="onb-choice-check" aria-hidden="true">{on && <Check size={13} strokeWidth={3} />}</span>
      <span className="onb-method-icon" aria-hidden="true">{icon}</span>
      <strong>{title}</strong>
      <span className="onb-choice-text">{text}</span>
      <ul>{points.map(point => <li key={point}><Check size={12} strokeWidth={3} aria-hidden="true" />{point}</li>)}</ul>
    </button>;
  };
  const termDays = PAYMENT_TERM_DAYS.find(days => draft.terms === paymentTermsText(days, draft.method));
  return <StepFrame {...common}
    icon={<Mail size={14} aria-hidden="true" />}
    title="Hoe verstuur je je facturen?"
    lead="Dit geldt ook voor herinneringen, aanmaningen en het klantportaal. Je kunt het later altijd omzetten bij Instellingen → Online betalen."
    footer={<Footer onBack={common.onBack} busy={busy} primaryLabel="Opslaan en verder" disabled={!draft.method}
      primary={() => void run(onSave, 'Je keuze kon niet worden opgeslagen.')} />}>
    {error && <Notice tone="error">{error}</Notice>}
    <div className="onb-choices is-two" role="radiogroup" aria-label="Facturen versturen">
      {option('email', <Mail size={22} />, 'Per e-mail', 'ResoFly mailt de factuur als PDF. Je klant maakt het bedrag over naar je IBAN, met het factuurnummer erbij.', ['Geen extra kosten', 'Geen Mollie-account nodig'])}
      {option('mollie', <CreditCard size={22} />, 'Via Mollie', 'Je factuur gaat met een betaallink mee. Je klant betaalt meteen met iDEAL, creditcard of Bancontact, en ResoFly zet de factuur zelf op betaald.', ['Sneller betaald', 'Betalingen vanzelf verwerkt', 'Mollie rekent een kleine vergoeding per betaling'])}
    </div>
    {draft.method === 'email' && !String(iban ?? '').trim() && <Notice tone="warn">
      Je IBAN ontbreekt nog. Zonder IBAN weet je klant niet waar hij naartoe kan overmaken. <button type="button" className="onb-link" onClick={onEditCompany}>IBAN invullen</button>
    </Notice>}
    {draft.method === 'mollie' && mollieConnected === false && <Notice tone="info">In de volgende stap koppel je je Mollie-account. Tot dat gebeurt, gaan je facturen zonder betaallink.</Notice>}

    <section className="onb-card">
      <div className="onb-card-head"><Receipt size={18} aria-hidden="true" /><h3>Betaaltermijn</h3></div>
      <div className="onb-seg" role="radiogroup" aria-label="Betaaltermijn">
        {PAYMENT_TERM_DAYS.map(days => <button key={days} type="button" role="radio" aria-checked={termDays === days} className={termDays === days ? 'is-on' : ''} onClick={() => onChange({ terms: paymentTermsText(days, draft.method) })}>{days} dagen</button>)}
        <button type="button" role="radio" aria-checked={termDays === undefined} className={termDays === undefined ? 'is-on' : ''} onClick={() => termDays !== undefined && onChange({ terms: '' })}>Eigen tekst</button>
      </div>
      <div className="onb-fields">
        <div className="onb-field span-6">
          <label htmlFor="onb-f-terms">Tekst onder de totalen</label>
          <Textarea id="onb-f-terms" rows={2} maxLength={500} value={draft.terms} onChange={event => onChange({ terms: event.target.value })} />
        </div>
        <div className="onb-field span-6">
          <label htmlFor="onb-f-footer">Voettekst</label>
          <Input id="onb-f-footer" maxLength={300} value={draft.footer} placeholder="Bedankt voor het vertrouwen." onChange={event => onChange({ footer: event.target.value })} />
          <small>Onderaan je offertes, facturen en contracten.</small>
        </div>
      </div>
    </section>
  </StepFrame>;
}

// ── 8 · Mollie koppelen ──────────────────────────────────────────────────────

function MollieStep({ organizationId, isOwner, sendMethod, status, loadError, onConnected, onRefresh, onNext, ...common }: StepCommon & {
  organizationId: string;
  isOwner: boolean;
  sendMethod: InvoiceSendMethod | null;
  status: InvoiceMollieSettingsStatus | null;
  loadError: string | null;
  onConnected: (status: InvoiceMollieSettingsStatus) => void;
  onRefresh: () => Promise<void>;
  onNext: () => void;
}) {
  const [key, setKey] = useState('');
  const [reveal, setReveal] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const { busy, error, setError, run } = useAction();
  const connected = status?.status === 'connected';
  const viaMollie = sendMethod === 'mollie';
  const mode = mollieKeyMode(key);

  async function connect() {
    const problem = mollieKeyProblem(key);
    if (problem) throw new Error(problem);
    setMessage(null);
    const result = await saveInvoiceMollieKey(organizationId, key.trim());
    // De key gaat meteen uit het scherm: hij staat nu versleuteld op de server.
    setKey('');
    setReveal(false);
    onConnected(result.status);
    const profile = result.status.profile?.name ? ` met het profiel "${result.status.profile.name}"` : '';
    setMessage(result.status.mode === 'live'
      ? `Mollie is gekoppeld${profile}. Je klanten kunnen nu online betalen.`
      : `Mollie is gekoppeld${profile}, in testmodus. Betalingen zijn dan niet echt; koppel een live-key voordat je echte facturen verstuurt.`);
  }

  const guide = [
    { icon: <Rocket size={18} />, title: 'Maak een Mollie-account', text: <>Ga naar <a href="https://www.mollie.com/nl" target="_blank" rel="noopener noreferrer">mollie.com <ExternalLink size={12} aria-hidden="true" /></a> en kies Aanmelden. Gebruik dezelfde bedrijfsnaam, rechtsvorm en hetzelfde KvK-nummer als hier.</> },
    { icon: <ShieldCheck size={18} />, title: 'Laat je account controleren', text: 'Mollie vraagt je KvK-gegevens, je zakelijke bankrekening (met een kleine controlebetaling) en een identiteitsbewijs. Dat duurt meestal één tot drie werkdagen. Tot dan kun je alleen testen.' },
    { icon: <KeyRound size={18} />, title: 'Kopieer je API-key', text: <>In je <a href="https://my.mollie.com/dashboard" target="_blank" rel="noopener noreferrer">Mollie-dashboard <ExternalLink size={12} aria-hidden="true" /></a>: Developers → API-keys. Kopieer de <strong>Live API-key</strong>; die begint met live_. Een Test API-key (test_) kan om eerst te proberen.</> },
    { icon: <Lock size={18} />, title: 'Plak hem hieronder', text: 'ResoFly controleert de key meteen bij Mollie en bewaart hem versleuteld. Daarna zie je alleen nog de laatste vier tekens.' },
  ];

  return <StepFrame {...common}
    icon={<CreditCard size={14} aria-hidden="true" />}
    title={connected ? 'Mollie is gekoppeld' : 'Mollie koppelen'}
    lead={viaMollie
      ? 'Zo komt er een betaallink op je facturen. Het geld komt binnen op je eigen Mollie-account, niet bij ResoFly.'
      : 'Optioneel: je verstuurt per e-mail. Koppel je Mollie toch, dan staat het klaar voor als je later via Mollie wilt versturen.'}
    footer={<Footer onBack={common.onBack} busy={busy}
      primaryLabel={connected ? 'Volgende' : 'Later koppelen'}
      primary={onNext} />}>
    {loadError && !status && <Notice tone="warn">{loadError} <button type="button" className="onb-link" onClick={() => void onRefresh()}>Opnieuw proberen</button></Notice>}
    {message && <Notice tone="ok">{message}</Notice>}
    {error && <Notice tone="error">{error}</Notice>}

    {connected && status && <section className="onb-card onb-connected">
      <div className="onb-card-head"><CheckCircle2 size={18} aria-hidden="true" /><h3>{status.profile?.name ?? 'Mollie-account'}</h3></div>
      <p>{status.mode === 'live' ? 'Live: echte betalingen.' : 'Testmodus: betalingen zijn niet echt.'}{status.key_suffix ? ` Key ••••${status.key_suffix}.` : ''}{status.profile?.website ? ` ${status.profile.website}` : ''}</p>
      {status.mode === 'test' && <Notice tone="warn">Koppel een live-key (live_…) voordat je echte facturen verstuurt. Dat kan later bij Instellingen → Online betalen.</Notice>}
      {status.profile?.status === 'unverified' && status.mode === 'live' && <Notice tone="warn">Mollie heeft je profiel nog niet goedgekeurd. Tot dan lukken echte betalingen niet; kijk in je Mollie-dashboard wat er nog nodig is.</Notice>}
    </section>}

    <ol className="onb-guide">
      {guide.map((item, i) => <li key={item.title}>
        <span className="onb-guide-icon" aria-hidden="true">{item.icon}</span>
        <div>
          <strong className="onb-guide-title"><span className="onb-guide-num">{i + 1}</span>{item.title}</strong>
          <p>{item.text}</p>
        </div>
      </li>)}
    </ol>

    {!connected && (isOwner ? <section className="onb-card onb-keyform">
      <div className="onb-card-head"><KeyRound size={18} aria-hidden="true" /><h3>Je API-key</h3></div>
      <div className="onb-key">
        <Input id="onb-f-mollie" type={reveal ? 'text' : 'password'} value={key} placeholder="live_…" autoComplete="off" spellCheck={false} autoCapitalize="off"
          aria-label="API-key van Mollie" onChange={event => { setKey(event.target.value); setError(null); }}
          onKeyDown={event => { if (event.key === 'Enter' && key.trim() && !busy) void run(connect, 'Mollie koppelen is niet gelukt.'); }} />
        <button type="button" className="btn btn-ghost onb-icon-btn" onClick={() => setReveal(r => !r)} aria-label={reveal ? 'Key verbergen' : 'Key tonen'} aria-pressed={reveal}>{reveal ? <EyeOff size={16} /> : <Eye size={16} />}</button>
        <button type="button" className="btn btn-primary" disabled={busy || !key.trim()} onClick={() => void run(connect, 'Mollie koppelen is niet gelukt.')}>{busy ? 'Controleren…' : 'Koppelen'}</button>
      </div>
      {mode === 'test' && <p className="onb-small">Dit is een test-key: betalingen via de link zijn dan niet echt.</p>}
      <p className="onb-small"><Lock size={12} aria-hidden="true" /> Deel je key nooit per mail of chat. Vertrouw je iets niet, trek de key dan in bij Mollie en koppel een nieuwe.</p>
    </section> : <Notice tone="info">
      Alleen de eigenaar van de organisatie kan Mollie koppelen: zo bepaalt alleen de eigenaar waar het geld van je klanten binnenkomt. Vraag de eigenaar om dit bij Instellingen → Online betalen te doen.
    </Notice>)}
  </StepFrame>;
}

// ── 9 · Klaar ───────────────────────────────────────────────────────────────

function DoneStep({ organization, isChild, settings, savedLegalForm, pendingLegalForm, billing, businessStatus, mollie, address, onGoTo, onFinish, ...common }: StepCommon & {
  organization: Organization;
  isChild: boolean;
  settings: CompanySettings | null;
  savedLegalForm: LegalForm;
  pendingLegalForm: LegalForm | null;
  billing: OrganizationBillingOverview | null;
  businessStatus: OrganizationBusinessStatus | null;
  mollie: InvoiceMollieSettingsStatus | null;
  /** Het webadres; null zolang het overzicht er niet is. */
  address: ClientDomainsOverview | null;
  onGoTo: (key: OnboardingStepKey) => void;
  onFinish: (next: SetupNext) => Promise<void>;
}) {
  const { busy, error, run } = useAction();
  const check = finishCheck({
    companyName: settings?.company_name, addressLine1: settings?.address_line1, savedLegalForm, pendingLegalForm,
    // Pas tegenhouden als bekend is dat er geen naam is; de database controleert het bij het afronden ook.
    clientSubdomain: address ? (address.subdomain?.name ?? null) : undefined,
  });
  const ready = check.blocking.length === 0;
  const s = settings;
  const name = organizationDisplayName(s?.company_name, s?.trade_name) || organization.name;
  const method = s?.invoice_send_method ?? null;
  const rows: Array<{ step: OnboardingStepKey; icon: ReactNode; label: string; value: string; detail?: string; warn?: boolean }> = [
    { step: 'rechtsvorm', icon: <Scale size={16} />, label: 'Rechtsvorm', value: LEGAL_FORM_LABELS[savedLegalForm], detail: pendingLegalForm ? `Gekozen: ${LEGAL_FORM_LABELS[pendingLegalForm]}, nog niet vastgelegd` : LEGAL_FORM_INFO[savedLegalForm].tax, warn: Boolean(pendingLegalForm) },
    { step: 'bedrijf', icon: <Building2 size={16} />, label: 'Bedrijf', value: s?.company_name?.trim() || 'Nog niet ingevuld', detail: [s?.address_line1, [s?.postal_code, s?.city].filter(Boolean).join(' ')].filter(v => v && String(v).trim()).join(', ') || undefined, warn: !s?.company_name?.trim() },
    { step: 'bedrijf', icon: <BadgeCheck size={16} />, label: 'Registratie', value: [s?.kvk_number ? `KvK ${s.kvk_number}` : 'Geen KvK-nummer', s?.vat_number || 'geen btw-id'].join(' · '), detail: s?.iban ? `IBAN ${s.iban}` : 'Nog geen IBAN', warn: !s?.iban },
    { step: 'webadres', icon: <Globe size={16} />, label: 'Webadres', value: address?.subdomain?.host ?? (address ? 'Nog niet gekozen' : '…'), detail: address?.subdomain ? 'Hier openen je klanten albums, offertes, facturen en het portaal' : undefined, warn: Boolean(address && !address.subdomain) },
    { step: 'btw', icon: <Calculator size={16} />, label: 'Btw', value: s?.kor_enabled ? 'KOR: geen btw' : `Aangifte ${s?.vat_return_period === 'monthly' ? 'per maand' : 'per kwartaal'}`, detail: `Boekjaar vanaf ${MONTH_NAMES[Math.max(0, Math.min(11, (s?.fiscal_year_start_month ?? 1) - 1))]}` },
    { step: 'facturen', icon: <Mail size={16} />, label: 'Facturen', value: method === 'mollie' ? 'Via Mollie, met betaallink' : method === 'email' ? 'Per e-mail' : 'Nog niet gekozen', warn: !method },
    { step: 'mollie', icon: <CreditCard size={16} />, label: 'Mollie', value: mollie?.status === 'connected' ? `Gekoppeld${mollie.mode === 'test' ? ', testmodus' : ''}` : 'Niet gekoppeld', warn: method === 'mollie' && mollie?.status !== 'connected' },
  ];
  if (!isChild) rows.push({ step: 'abonnement', icon: <Layers size={16} />, label: 'Pakket', value: billing ? (billing.billing_exempt ? 'Vrijgesteld' : `${billing.plan_name}${billing.mollie_subscription_id ? '' : ', nog geen abonnement'}`) : '–', detail: businessStatus?.active ? 'Zakelijke module aan' : undefined });

  const after: Array<{ next: SetupNext; icon: ReactNode; title: string; text: string }> = [
    { next: 'team', icon: <UserPlus size={18} />, title: 'Team uitnodigen', text: 'Collega’s, met rechten per module.' },
    { next: 'agenda', icon: <CalendarDays size={18} />, title: 'Agenda koppelen', text: 'Google of Microsoft 365.' },
    { next: 'bank', icon: <Landmark size={18} />, title: 'Bank koppelen', text: 'Je mutaties vanzelf binnen.' },
  ];

  return <StepFrame {...common}
    icon={<CheckCircle2 size={14} aria-hidden="true" />}
    title={ready ? <>Klaar om te <span className="onb-gold">beginnen</span></> : 'Nog even dit'}
    lead={ready
      ? <>Zo staat <strong>{name}</strong> erin. Klopt er iets niet, klik dan op een regel om terug te gaan. Alles is later aan te passen bij Instellingen.</>
      : 'Een paar dingen moeten er nog in voordat je kunt beginnen.'}
    footer={<Footer onBack={common.onBack} busy={busy} primaryLabel="Naar mijn werkruimte" disabled={!ready}
      primary={() => void run(() => onFinish('dashboard'), 'Afronden is niet gelukt.')} />}>
    {error && <Notice tone="error">{error}</Notice>}
    {check.blocking.map(item => <Notice key={item.text} tone="warn">{item.text} <button type="button" className="onb-link" onClick={() => onGoTo(item.step)}>Aanpassen</button></Notice>)}
    <div className="onb-summary">
      {rows.map(row => <button key={row.label} type="button" className={`onb-summary-row${row.warn ? ' is-warn' : ''}`} onClick={() => onGoTo(row.step)}>
        <span className="onb-summary-icon" aria-hidden="true">{row.icon}</span>
        <span className="onb-summary-text">
          <small>{row.label}</small>
          <strong>{row.value}</strong>
          {row.detail && <em>{row.detail}</em>}
        </span>
        <span className="onb-summary-edit">Wijzigen</span>
      </button>)}
    </div>
    {ready && <section className="onb-after">
      <h3>Daarna, als je wilt</h3>
      <div className="onb-after-grid">
        {after.map(item => <button key={item.next} type="button" className="onb-after-card" disabled={busy} onClick={() => void run(() => onFinish(item.next), 'Afronden is niet gelukt.')}>
          <span aria-hidden="true">{item.icon}</span>
          <strong>{item.title}</strong>
          <small>{item.text}</small>
        </button>)}
      </div>
      <p className="onb-small">Deze knoppen ronden ook af, en openen dan meteen die plek.</p>
    </section>}
  </StepFrame>;
}

// ── Voor een teamlid: de organisatie wordt nog ingericht ─────────────────────

export function OrganizationSetupPending({ organization, organizations, userEmail, onSwitchOrganization, onReload, onSignOut }: {
  organization: Organization;
  organizations: Organization[];
  userEmail: string | null;
  onSwitchOrganization: (organizationId: string) => Promise<void>;
  onReload: () => Promise<void>;
  onSignOut: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const others = organizations.filter(org => org.id !== organization.id && org.onboarding_completed_at !== null);
  return <div className="onb onb-pending">
    <main className="onb-pending-card">
      <span className="onb-brand-tile is-big" aria-hidden="true"><BrandMark size={40} /></span>
      <h1>{organization.name} wordt nog ingericht</h1>
      <p>De eigenaar of een beheerder loopt eerst de stappen door: rechtsvorm, bedrijfsgegevens, btw en betalen. Zodra dat klaar is, kun je hier aan de slag.</p>
      <div className="onb-pending-actions">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => { setBusy(true); void onReload().finally(() => setBusy(false)); }}>
          <RefreshCw size={15} aria-hidden="true" /> {busy ? 'Kijken…' : 'Opnieuw kijken'}
        </button>
        {others.map(org => <button key={org.id} type="button" className="btn btn-ghost" disabled={busy} onClick={() => { setBusy(true); void onSwitchOrganization(org.id).finally(() => setBusy(false)); }}>Naar {org.name}</button>)}
      </div>
      <p className="onb-small">{userEmail ? <>Ingelogd als {userEmail}. </> : null}<button type="button" className="onb-link" onClick={onSignOut}>Uitloggen</button></p>
    </main>
  </div>;
}

