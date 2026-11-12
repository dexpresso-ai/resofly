import { useState } from 'react';
import { Check, Copy, ExternalLink, MonitorSmartphone, X } from 'lucide-react';
import { Button } from './Ui';
import { installableApps, isRunningInstalled, WORKSPACE_APP, type InstallableApp } from '../lib/standaloneApps';
import { INSTALL_STEPS, installHint, promptInstall, useInstallPrompt } from '../lib/installPrompt';
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
 */
export function InstallAppCard({ app }: { app: InstallableApp }) {
  const { canPrompt, installed } = useInstallPrompt();
  const [dismissed, setDismissed] = useState(() => readDismissed(app));
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
    const url = `${window.location.origin}${app.path}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(app.id);
      window.setTimeout(() => setCopied(current => (current === app.id ? null : current)), 2500);
    } catch {
      // Geen klembord (oude browser, of geweigerd): dan laten we het adres zien.
      window.prompt('Kopieer dit adres:', url);
    }
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
