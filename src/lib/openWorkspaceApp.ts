import { WORKSPACE_APP } from './standaloneApps.ts';
import type { InstallHint } from './installPrompt.ts';

/**
 * "Volledige werkruimte" in een losse app (Agenda, Financiën, Communicatie):
 * de geïnstalleerde ResoFly-app openen, niet het adres in een browser. Staat
 * ResoFly niet op het apparaat, dan zeggen we eerst dat je hem moet installeren.
 *
 * Tot 16 november deed de knop in een geïnstalleerde app
 * `window.open('/app/werkruimte/', '_blank', 'noopener')`. Met dat derde
 * argument maakt de browser er een pop-upvenster van, en een pop-up stuurt
 * Chrome nooit door naar een geïnstalleerde app. Je kreeg dus het adres in een
 * kaal browservenster. Een klik op een link met target="_blank" stuurt Chrome
 * wél door naar de app die dat adres heeft: op Windows, Mac en Linux sinds
 * Chrome 139, op Android sinds Chrome 158 (november 2026). Daarom klikken we
 * hier een link aan (openInApp).
 *
 * Wat elk platform toelaat:
 * - Chrome en Edge op de computer: de link opent in de ResoFly-app als die er
 *   staat. Of hij er staat, kan een andere app niet vragen:
 *   getInstalledRelatedApps kijkt op de computer alleen binnen de eigen scope.
 *   Dat onthouden we dus zelf. De werkruimte-app zet bij het opstarten een vlag
 *   in localStorage, en die opslag deelt hij met de losse apps.
 * - Chrome op Android: hetzelfde, en daar kán de losse app het vragen. Dat kan
 *   dankzij related_applications in zijn manifest en
 *   /.well-known/assetlinks.json.
 * - iPhone en iPad: een app op het beginscherm kan geen andere app openen, en
 *   ook niet zien welke er staan, want elke app heeft zijn eigen opslag. Daar
 *   leggen we uit hoe je ResoFly vanaf het beginscherm opent, of eerst
 *   installeert.
 * - Safari op de Mac (Voeg toe aan Dock) en andere browsers: ook daar heeft elke
 *   app zijn eigen opslag, of zijn er geen apps. De link gaat gewoon open. Staat
 *   ResoFly in het Dock, dan opent macOS hem daar. Anders opent Safari hem, met
 *   bovenaan de uitleg om hem te installeren (INSTALL_PARAM).
 */

/** Staat de ResoFly-app op dit apparaat? 'unknown': daar kunnen we niet bij. */
export type WorkspaceAppStatus = 'installed' | 'not-installed' | 'unknown';

/**
 * Wat de knop doet:
 * - 'same-tab': in een gewoon browsertabblad gewoon daarheen, zoals altijd;
 * - 'open-app': een link naar de ResoFly-app;
 * - 'install-first': eerst de melding dat je hem moet installeren;
 * - 'home-screen': de melding voor iPhone en iPad.
 */
export type WorkspaceOpenPlan = 'same-tab' | 'open-app' | 'install-first' | 'home-screen';

/** In het adres van de werkruimte: toon de installeerkaart, ook als je die ooit wegklikte. */
export const INSTALL_PARAM = 'installeren';
export const WORKSPACE_INSTALL_URL = `${WORKSPACE_APP.path}?${INSTALL_PARAM}=1`;

const SEEN_KEY = 'resofly.app-geinstalleerd.werkruimte';

type KeyValueStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function defaultStore(): KeyValueStore | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

/** De werkruimte draait hier als app, of is net geïnstalleerd. */
export function rememberWorkspaceAppInstalled(store: KeyValueStore | null = defaultStore()): void {
  try { store?.setItem(SEEN_KEY, new Date().toISOString()); } catch { /* privémodus: dan weten we het niet */ }
}

export function forgetWorkspaceAppInstalled(store: KeyValueStore | null = defaultStore()): void {
  try { store?.removeItem(SEEN_KEY); } catch { /* idem */ }
}

export function workspaceAppSeenInstalled(store: KeyValueStore | null = defaultStore()): boolean {
  try { return Boolean(store?.getItem(SEEN_KEY)); } catch { return false; }
}

type RelatedApp = { platform?: string; url?: string; id?: string };
type NavigatorWithRelatedApps = { getInstalledRelatedApps?: () => Promise<RelatedApp[]> };

/**
 * Vraag de browser of de ResoFly-app geïnstalleerd is. null als de browser
 * dat niet kan (Safari, Firefox) of er iets misgaat.
 *
 * Een `false` is alleen op Android te vertrouwen. Op de computer antwoordt
 * Chrome alleen voor een app waarvan de pagina zelf binnen de scope valt, en
 * met een volledig `id`-adres in het manifest. Dat adres verschilt per
 * omgeving, dus dat staat er niet in.
 */
export async function askBrowserForWorkspaceApp(nav: NavigatorWithRelatedApps | undefined = typeof navigator === 'undefined' ? undefined : navigator as NavigatorWithRelatedApps): Promise<boolean | null> {
  const ask = nav?.getInstalledRelatedApps;
  if (typeof ask !== 'function') return null;
  try {
    const apps = await ask.call(nav);
    return apps.some(app => app.platform === 'webapp' && isWorkspaceManifest(app.url));
  } catch {
    return null;
  }
}

function isWorkspaceManifest(url: string | undefined): boolean {
  if (!url) return false;
  try { return new URL(url, 'https://resofly.invalid').pathname === WORKSPACE_APP.manifest; } catch { return false; }
}

export function isAndroid(userAgent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent): boolean {
  return /Android/i.test(userAgent);
}

/**
 * Staat de ResoFly-app hier? Alleen Chrome en Edge kunnen we het vragen of
 * onthouden. Daarbuiten heeft elke app zijn eigen opslag (iPhone, iPad,
 * Safari op de Mac) of zijn er geen apps (Firefox).
 *
 * Zonder vlag en zonder ja van de browser zeggen we 'not-installed'. Staat hij
 * er toch, maar is hij sinds deze versie nog niet opgestart, dan zie je één
 * keer de melding. De knop daarin (ResoFly installeren) is zelf een link naar
 * de app, en opent hem dan alsnog.
 */
export function workspaceAppStatus({ hint, seenInstalled, browserSays }: { hint: InstallHint; seenInstalled: boolean; browserSays: boolean | null }): WorkspaceAppStatus {
  if (hint !== 'chromium') return 'unknown';
  return seenInstalled || browserSays === true ? 'installed' : 'not-installed';
}

export function planWorkspaceOpen({ runningInstalled, hint, status }: { runningInstalled: boolean; hint: InstallHint; status: WorkspaceAppStatus }): WorkspaceOpenPlan {
  // In een gewoon browsertabblad is de browser de plek waar je werkt; daar
  // blijft de werkruimte, in hetzelfde tabblad.
  if (!runningInstalled) return 'same-tab';
  if (hint === 'ios') return 'home-screen';
  if (status === 'not-installed') return 'install-first';
  return 'open-app';
}

/**
 * Open een adres zoals een klik op een link met target="_blank". Een browser
 * stuurt dat door naar de geïnstalleerde app die bij het adres hoort. Een
 * pop-up van window.open met een derde argument stuurt hij niet door (zie
 * boven). Moet binnen de klik van de gebruiker draaien, anders houdt de
 * browser het tegen.
 */
export function openInApp(url: string, doc: Document = document): void {
  const link = doc.createElement('a');
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener';
  link.style.display = 'none';
  doc.body.appendChild(link);
  link.click();
  link.remove();
}

/**
 * Haal de installeervraag uit het adres. `requested` betekent: toon de
 * installeerkaart, ook als je die ooit wegklikte. Dat gebeurt als je hier komt
 * via ResoFly installeren in een losse app. `search` is het adres zonder de
 * vraag, zodat een herlaadbeurt de kaart niet nog eens opdringt.
 */
export function takeInstallRequest(search: string): { requested: boolean; search: string } {
  const params = new URLSearchParams(search);
  if (!params.has(INSTALL_PARAM)) return { requested: false, search };
  params.delete(INSTALL_PARAM);
  const rest = params.toString();
  return { requested: true, search: rest ? `?${rest}` : '' };
}

/**
 * Op /app/werkruimte/: onthoud of de app hier staat, zodat de losse apps het
 * weten. Draait hij als app of wordt hij net geïnstalleerd, dan ja. In de
 * browser op Android kan de pagina het de browser vragen: zo vergeten we ook
 * een app die verwijderd is. Op de computer kan dat niet (zie
 * askBrowserForWorkspaceApp). Een verwijderde app opent daar dan in een
 * browsertabblad, met de kaart om hem opnieuw te installeren.
 */
export function trackWorkspaceApp({ runningInstalled, android, win = window }: { runningInstalled: boolean; android: boolean; win?: Window }): void {
  if (runningInstalled) {
    rememberWorkspaceAppInstalled();
    return;
  }
  win.addEventListener('appinstalled', () => rememberWorkspaceAppInstalled());
  if (!android) return;
  void askBrowserForWorkspaceApp(win.navigator as NavigatorWithRelatedApps).then((answer) => {
    if (answer === true) rememberWorkspaceAppInstalled();
    else if (answer === false) forgetWorkspaceAppInstalled();
  });
}
