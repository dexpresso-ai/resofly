import { useEffect, useState, type ReactNode } from 'react';
import { Check, Copy, ExternalLink, MonitorSmartphone, X } from 'lucide-react';
import { Button } from './Ui';
import { Modal } from './Modal';
import { installableApps, isRunningInstalled, WORKSPACE_APP, type InstallableApp } from '../lib/standaloneApps';
import { INSTALL_STEPS, installHint, promptInstall, useInstallPrompt } from '../lib/installPrompt';
import { askBrowserForWorkspaceApp, isAndroid, openInApp, planWorkspaceOpen, rememberWorkspaceAppInstalled, WORKSPACE_INSTALL_URL, workspaceAppSeenInstalled, workspaceAppStatus } from '../lib/openWorkspaceApp';
import type { Permissions } from '../lib/permissions';

/** Wie de kaart wegklikt, krijgt hem in deze browser niet meer te zien. */
const dismissKey = (app: InstallableApp) => `resofly.app-install.${app.id}`;

function readDismissed(app: InstallableApp): boolean {
  try { return localStorage.getItem(dismissKey(app)) === '1'; } catch { return false; }
}

/**
 * In een app die nog niet geïnstalleerd is (een losse app, of de werkruimte op
 * /app/werkruimte/): één kaart onderin met "Installeer ResoFly Agenda". Chrome en Edge krijgen een knop die de vraag van
 * de browser opent; Safari kan dat niet en krijgt de twee tikken die het daar
 * kost. Klikte je de kaart weg, dan staat hij er niet.
 *
 * De knop staat er zodra de browser installeren aanbiedt, ook in een
 * app-venster: wie de werkruimte als app heeft, opent de losse app vanuit
 * Instellingen soms in een venster van die werkruimte-app, en moet hem daar
 * ook kunnen installeren. De browser biedt het niet aan voor een app die er al
 * is, dus dan staat er ook geen kaart.
 *
 * In Chrome zonder knop van de browser tonen we niets: dan is de app al
 * geïnstalleerd of nog niet installeerbaar, en een uitleg zonder knop is daar
 * alleen ruis. De uitleg voor Safari alleen in de browser zelf: draait hij als
 * app, dan is hij al op het beginscherm gezet.
 *
 * `force`: je komt hier via ResoFly installeren in een losse app
 * (openWorkspaceApp.ts). Dan staat de kaart er ook als je hem ooit wegklikte;
 * daar kwam je voor.
 */
export function InstallAppCard({ app, force = false }: { app: InstallableApp; force?: boolean }) {
  const { canPrompt, installed } = useInstallPrompt();
  const [dismissed, setDismissed] = useState(() => !force && readDismissed(app));
  const [hint] = useState(() => installHint());
  if (dismissed || installed) return null;
  if (!canPrompt && (isRunningInstalled() || (hint !== 'ios' && hint !== 'mac-safari'))) return null;

  function dismiss() {
    try { localStorage.setItem(dismissKey(app), '1'); } catch { /* privémodus: dan alleen voor nu */ }
    setDismissed(true);
  }

  return <div className="email-toast app-install" role="region" aria-label={`${app.name} installeren`}>
    <div className="app-install-main">
      <img className="app-install-icon" src={app.icon} alt="" width={36} height={36} />
      <span className="email-toast-text">
        <strong>Installeer {app.name}</strong>
        <span className="app-install-sub">
          {canPrompt ? `Open ${app.shortName} voortaan met één tik, in een eigen venster.` : INSTALL_STEPS[hint]}
        </span>
      </span>
      {canPrompt && <Button variant="primary" className="app-install-btn" onClick={() => { void promptInstall(); }}>Installeren</Button>}
    </div>
    <button type="button" className="email-toast-close" aria-label="Niet nu" title="Niet nu" onClick={dismiss}>
      <X size={14} />
    </button>
  </div>;
}

/**
 * Instellingen → Apps: ResoFly zelf en de losse apps waar dit teamlid bij kan,
 * met een knop om ze te openen (daar installeer je ze) en een knop om het adres
 * te kopiëren, voor wie hem op zijn telefoon wil zetten.
 */
export function AppsSettingsPanel({ permissions }: { permissions: Permissions }) {
  const apps = installableApps(permissions.canOpenPage);
  const moduleApps = apps.filter(app => app.id !== WORKSPACE_APP.id);
  const [copied, setCopied] = useState<string | null>(null);
  const [hint] = useState(() => installHint());
  // In de werkruimte als app is er geen adresbalk en geen Deel-knop.
  const [inApp] = useState(() => isRunningInstalled());

  async function copy(app: InstallableApp) {
    if (!await copyAddress(`${window.location.origin}${app.path}`)) return;
    setCopied(app.id);
    window.setTimeout(() => setCopied(current => (current === app.id ? null : current)), 2500);
  }

  return <section className="settings-card organization-card">
    <div className="settings-card-head">
      <div>
        <h3><MonitorSmartphone size={15} aria-hidden="true" style={{ verticalAlign: '-2px', marginRight: 6 }} />Apps</h3>
        <p className="settings-help">
          Zet ResoFly en de onderdelen die je het meest gebruikt elk als eigen app op je telefoon, in je dock of in je taakbalk.
          Agenda, Financiën en Communicatie openen meteen op de goede pagina, en hun menu toont alleen wat erbij hoort.
          Je logt in met hetzelfde account en ziet precies wat je hier ook ziet.
        </p>
      </div>
    </div>

    <div className="app-list">
      {apps.map(app => <div className="app-row" key={app.id}>
        <img className="app-row-icon" src={app.icon} alt="" width={44} height={44} />
        <div className="app-row-text">
          <strong>{app.name}</strong>
          <span>{app.description}</span>
        </div>
        <div className="app-row-actions">
          <a className="btn btn-primary" href={app.path} target="_blank" rel="noopener">
            <ExternalLink size={14} aria-hidden="true" />Openen
          </a>
          <Button onClick={() => { void copy(app); }} aria-label={`Adres van ${app.name} kopiëren`}>
            {copied === app.id ? <><Check size={14} aria-hidden="true" />Gekopieerd</> : <><Copy size={14} aria-hidden="true" />Link</>}
          </Button>
        </div>
      </div>)}
    </div>
    {moduleApps.length === 0 && <p className="settings-help">Agenda, Financiën en Communicatie staan voor jou in deze organisatie dicht. Die apps zijn er voor jou dus niet.</p>}

    <div className="app-steps">
      <strong>Zo installeer je een app</strong>
      <ol>
        <li>{inApp
          ? <>Je gebruikt ResoFly nu zelf als app. Kopieer de <b>Link</b> en open hem in je browser (Chrome, Edge of Safari).</>
          : <>Kies <b>Openen</b>. Op je telefoon: kopieer de link en open hem daar in de browser.</>}</li>
        <li>{hint === 'chromium'
          ? 'Kies in de app op Installeren, of klik in de adresbalk op het installeericoon.'
          : INSTALL_STEPS[hint]}</li>
        <li>Log in als dat gevraagd wordt. Daarna staat de app tussen je andere apps.</li>
      </ol>
      {/* Tot 12 november claimde de ResoFly-app heel ResoFly; Android hield een
          tweede app dan voor dezelfde. Een oude app werkt zich vanzelf bij, maar
          niet meteen. */}
      <p className="settings-help">
        Zegt je telefoon bij Agenda, Financiën of Communicatie dat de app al geïnstalleerd is?
        Dan staat er nog een oude ResoFly-app op. Verwijder die één keer en installeer ResoFly hierboven opnieuw.
        Daarna kun je de andere apps ernaast zetten.
      </p>
    </div>
  </section>;
}

/**
 * Kopieer een adres. Zonder klembord (oude browser, of geweigerd) laten we het
 * adres zien om zelf over te nemen. true als het op het klembord staat.
 */
async function copyAddress(url: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(url);
    return true;
  } catch {
    window.prompt('Kopieer dit adres:', url);
    return false;
  }
}

type WorkspaceDialogKind = 'install-first' | 'home-screen';

/**
 * "Volledige werkruimte" in een losse app: open de ResoFly-app, of zeg eerst
 * dat je hem moet installeren. De regels staan in lib/openWorkspaceApp.ts.
 *
 * `enabled` alleen in een losse app. Op Android vragen we de browser vooraf of
 * ResoFly er staat, en opnieuw als je terugkomt in de app (misschien heb je
 * hem net geïnstalleerd). Bij de klik zelf is geen tijd om te wachten: een
 * browser opent een link alleen tijdens de klik.
 */
export function useOpenWorkspace(enabled: boolean): { open: () => void; dialog: ReactNode } {
  const [hint] = useState(() => installHint());
  const [browserSays, setBrowserSays] = useState<boolean | null>(null);
  const [dialog, setDialog] = useState<WorkspaceDialogKind | null>(null);

  useEffect(() => {
    if (!enabled || hint !== 'chromium' || !isAndroid()) return;
    let alive = true;
    const ask = () => {
      void askBrowserForWorkspaceApp().then((answer) => {
        if (!alive) return;
        if (answer) rememberWorkspaceAppInstalled();
        setBrowserSays(answer);
      });
    };
    ask();
    const onVisible = () => { if (document.visibilityState === 'visible') ask(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { alive = false; document.removeEventListener('visibilitychange', onVisible); };
  }, [enabled, hint]);

  function open() {
    const status = workspaceAppStatus({ hint, seenInstalled: workspaceAppSeenInstalled(), browserSays });
    const plan = planWorkspaceOpen({ runningInstalled: isRunningInstalled(), hint, status });
    if (plan === 'same-tab') window.location.assign('/');
    else if (plan === 'open-app') openInApp(WORKSPACE_APP.path);
    else setDialog(plan);
  }

  return {
    open,
    dialog: dialog && <WorkspaceAppDialog kind={dialog} onClose={() => setDialog(null)} />,
  };
}

/**
 * De melding als ResoFly niet te openen is: niet geïnstalleerd (Chrome, Edge),
 * of op een iPhone of iPad, waar de ene app de andere niet kan openen.
 */
function WorkspaceAppDialog({ kind, onClose }: { kind: WorkspaceDialogKind; onClose: () => void }) {
  const [copied, setCopied] = useState(false);

  if (kind === 'home-screen') {
    const url = `${window.location.origin}${WORKSPACE_APP.path}`;
    return <Modal
      title="Open ResoFly vanaf je beginscherm"
      className="app-open-modal"
      onClose={onClose}
      footer={<>
        <Button type="button" onClick={onClose}>Sluiten</Button>
        <Button type="button" variant="primary" onClick={() => { void copyAddress(url).then(setCopied); }}>
          {copied ? <><Check size={14} aria-hidden="true" />Gekopieerd</> : <><Copy size={14} aria-hidden="true" />Link kopiëren</>}
        </Button>
      </>}
    >
      <div className="app-open">
        <img className="app-open-icon" src={WORKSPACE_APP.icon} alt="" width={48} height={48} />
        <p>Op een iPhone of iPad kan de ene app de andere niet openen. Ga naar je beginscherm en tik daar op <b>ResoFly</b>.</p>
        <div className="app-steps">
          <strong>Staat ResoFly er nog niet op? Installeer hem dan eerst.</strong>
          <ol>
            <li>Kies <b>Link kopiëren</b>.</li>
            <li>Open Safari en plak de link in de adresbalk.</li>
            <li>Tik op Deel (het vierkantje met de pijl omhoog) en kies <b>Zet op beginscherm</b>.</li>
          </ol>
        </div>
      </div>
    </Modal>;
  }

  const device = isAndroid() ? 'je telefoon' : 'deze computer';
  return <Modal
    title="Installeer eerst de ResoFly-app"
    className="app-open-modal"
    onClose={onClose}
    footer={<>
      {/* Wie nu niet wil installeren, kan nog altijd in de browser verder. "/"
          valt onder geen enkele app, dus dit blijft in de browser. */}
      <Button type="button" onClick={() => { openInApp('/'); onClose(); }}>In de browser openen</Button>
      <Button type="button" variant="primary" onClick={() => { openInApp(WORKSPACE_INSTALL_URL); onClose(); }}>
        <ExternalLink size={14} aria-hidden="true" />ResoFly installeren
      </Button>
    </>}
  >
    <div className="app-open">
      <img className="app-open-icon" src={WORKSPACE_APP.icon} alt="" width={48} height={48} />
      <p><b>Volledige werkruimte</b> opent de app ResoFly. Die staat nog niet op {device}.</p>
      <div className="app-steps">
        <ol>
          <li>Kies <b>ResoFly installeren</b>. ResoFly opent dan in je browser.</li>
          <li>Kies daar onderin op <b>Installeren</b>.</li>
          <li>Daarna opent <b>Volledige werkruimte</b> meteen de app.</li>
        </ol>
      </div>
      <p className="settings-help">Staat ResoFly er toch al op? Dan opent dezelfde knop gewoon de app.</p>
    </div>
  </Modal>;
}
