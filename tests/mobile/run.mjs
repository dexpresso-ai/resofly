#!/usr/bin/env node
/*
 * Mobiele lay-outtest — `npm run test:mobile`
 *
 * Opent elke pagina van de werkruimte op telefoon- en tabletformaat tegen een
 * nagebootste backend (tests/mobile/mock) en faalt zodra:
 *   1. de pagina een JavaScript-fout gooit;
 *   2. de inhoud horizontaal uit beeld loopt (de pagina of `.content` scrolt zijwaarts);
 *   3. de vaste chrome (titelbalk + werktabs + onderbalk) meer ruimte pakt dan
 *      afgesproken — op de telefoon 112px, op de tablet 100px;
 *   4. het eerste échte item van een pagina (de eerste klant, taak, ticket…)
 *      lager begint dan de grens in FIRST_ITEM. Dat is de meting waar deze
 *      test om bestaat: koppen, knoppenbalken en filters mogen niet weer
 *      langzaam het scherm opeten;
 *   5. twee delen die naast elkaar horen (`apart` in PAGES) ergens tijdens
 *      het scrollen over elkaar heen liggen;
 *   6. iets wat er moet staan (`mustShow` in PAGES) ontbreekt, zoals het logo
 *      van de leverancier of de regel over ResoFly onder het klantportaal.
 *
 * Opties:
 *   --theme=dark|light|both     standaard dark
 *   --look=cockpit|zenit|stroom meet een andere look dan Baken, de standaard sinds 2026-11-06
 *                               (zonder deze optie meet de test Baken)
 *   --viewports=phone,tablet    standaard phone,tablet,landscape,laptop (ook: desktop)
 *   --pages=dashboard,clients   standaard alle pagina's
 *   --shots=<map>               schrijf per pagina een screenshot weg
 *   --url=http://…              gebruik een draaiende dev-server i.p.v. er zelf een te starten
 *
 * Vereist Chromium van Playwright: `npx playwright install chromium`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import { installMock, storageScript, seed } from './mock/backend.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const VIEWPORTS = {
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, maxChrome: 112 },
  tablet: { viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, maxChrome: 100 },
  // Dezelfde telefoon, gekanteld. Een laag scherm is een ander probleem dan
  // een smal scherm: hier gaat de hoogte op aan koppen en balken, en wat
  // eronder valt is niet te bereiken als de pagina zelf niet mag scrollen.
  landscape: { viewport: { width: 740, height: 360 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, maxChrome: 112 },
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false, maxChrome: 130 },
  // Een laptop, met de zijbalk ingeklapt. Documentopmaak heeft hier zijn
  // middelste stand (de editor is 760-1179px breed): velden links, blad en
  // instellingen rechts. De tablet krijgt één kolom en desktop drie, dus
  // geen van beide zag dat de velden hier over de instellingen schoven
  // (2026-11-06). Alleen de pagina's in `only`: de standaardronde blijft kort.
  laptop: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false, maxChrome: 130, only: ['settings-documenten'] },
};

/**
 * Een stap van de inrichting van een nieuwe organisatie (OrganizationSetup,
 * 2026-11-07). Een eigen backend: de organisatie is nieuw (mock met
 * { onboarding: true }), en de voortgang in de opslag opent de stap meteen.
 */
const SETUP_ORDER = ['welkom', 'rechtsvorm', 'abonnement', 'bedrijf', 'webadres', 'btw', 'huisstijl', 'facturen', 'mollie', 'klaar'];
function setupPage(step, { pendingLegalForm = null } = {}) {
  const completed = SETUP_ORDER.slice(0, SETUP_ORDER.indexOf(step));
  // Na de stap Webadres is er een adres gekozen (2026-11-08).
  const subdomain = SETUP_ORDER.indexOf(step) > SETUP_ORDER.indexOf('webadres') ? 'studio-lopik' : null;
  return {
    page: 'dashboard', mock: { onboarding: true, subdomain }, shell: '.onb',
    storage: { [`resofly.onboarding.${seed.ids.ORG}`]: JSON.stringify({ step, completed, pendingLegalForm }) },
  };
}

/**
 * Wat er op een pagina moet staan (`mustShow`): een element met een maat, en
 * zo nodig met deze tekst erin. Niet per se in beeld: de voetregel staat
 * onderaan.
 */
// Onder elk scherm van het klantportaal, ook als de leverancier "Geleverd via
// ResoFly" heeft uitgezet (2026-11-12).
const PORTAL_CREDIT = { selector: '.portal-foot-by', text: 'beschikbaar gesteld door ResoFly', label: 'de regel over ResoFly onderaan' };
// Het logo in de kop van het portaal, op een licht plaatje (het testlogo heeft
// donkere letters, die op de donkere kop wegvallen).
const PORTAL_LOGO_ON_PLATE = { selector: '.portal-hero .brand-logo.plate-light img', label: 'het logo op een licht plaatje in de kop' };

/** Welke pagina's, en met welk tabblad ze openen. */
const PAGES = {
  dashboard: 'dashboard', gerrie: 'gerrie', weekplanner: 'weekplanner', calendar: 'calendar', time: 'time',
  clients: 'clients', client: { page: 'client', clientId: seed.clients[0].id },
  projects: 'projects', project: { page: 'project', projectId: seed.projects[0].id },
  'project-planning': 'project-planning', tickets: 'tickets', chat: 'chat', marketing: 'marketing',
  // Berichten opent mét de filters uitgeklapt. Dat is de stand waarin de balk
  // het hoogst is, en precies daar ging het liggend mis: de lijst werd tot
  // nul samengedrukt achter een rand waar je niet langs kon scrollen.
  communication: { page: 'communication', prepare: '.comm-filter-toggle' },
  // De agenda met een afspraak open, en met een taak open. Het detailpaneel
  // van een afspraak had een hook ná zijn vroege return: elke afspraak die je
  // aantikte gooide de hele app weg en liet een zwart scherm achter. Geen
  // lay-outfout, dus geen enkele meting hier zag het — alleen openen doet dat.
  'calendar-event': { page: 'calendar', prepare: 'button.tb-ev:not(.tb-task-block)' },
  'calendar-task': { page: 'calendar', prepare: '.tb-task-block' },
  // De maand (2026-11-13): op de telefoon het hele rooster met weeknummers,
  // zonder daglijst eronder. Die lijst nam een derde van het scherm en drukte
  // de weekrijen zo plat dat er per dag maar één regel overbleef.
  'calendar-month': { page: 'calendar', prepare: 'button.tb-vbtn[title^="Maandweergave"]' },
  content: 'content', notes: 'notes', documents: 'documents', stats: 'stats',
  // Rapportages met Gerrie (2026-11-09): het overzicht, de rapportbouwer van
  // voorheen (tweede tabblad), één rapportage met het kader, en dezelfde
  // rapportage met het gesprek open (op telefoon en tablet een paneel).
  'stats-builder': { page: 'stats', prepare: '.aire-mode button:nth-child(2)' },
  report: { page: 'report', statsReportId: seed.aiReports[0].id },
  'report-chat': { page: 'report', statsReportId: seed.aiReports[0].id, prepare: '.aire-chat-toggle' },
  // Gerrie aan het werk (2026-11-10). De mock laat report_chat openstaan, dus
  // hij blijft bouwen. Een nieuwe rapportage: de opbouwanimatie in plaats van
  // de pagina. Een bestaande aanpassen: de pagina gedimd, met de balk erboven
  // (op telefoon en tablet eerst het gesprek open, vraag sturen, weer dicht).
  'report-building': { page: 'stats', prepare: '.aire-ask .aire-suggest button' },
  // Agents van Gerrie (2026-11-11). De seed heeft een agent die nu draait: zijn
  // detail met de werkbank (de animatie), en de bouwer waarin je een agent in
  // een gesprek laat maken. Het overzicht zelf is de pagina "gerrie".
  'gerrie-agent': { page: 'gerrie', prepare: '.agx-card.is-working .agx-card-open' },
  'gerrie-bouwer': { page: 'gerrie', prepare: '.agx-hero-foot .agx-link' },
  // Gerrie → Gesprekken (2026-11-12): de lijst met eerdere chats, en één chat
  // open (op telefoon en tablet in plaats van de lijst, met een terugknop).
  'gerrie-gesprekken': { page: 'gerrie', prepare: '.cc-tab:has-text("Gesprekken")' },
  'gerrie-gesprek': { page: 'gerrie', prepare: ['.cc-tab:has-text("Gesprekken")', '.gsp-item'] },
  // Gerrie aanzetten (2026-11-12): zolang hij uit staat, toont de pagina Gerrie
  // de drie punten met elk een vinkje. Instellingen → AI heeft dezelfde punten
  // (settings-ai-uit) of, als hij aanstaat, de knop om hem uit te zetten (settings-ai).
  'gerrie-aanzetten': { page: 'gerrie', mock: { aiOff: true } },
  'settings-ai': { page: 'settings', prepare: '[data-settings-tab="ai"]' },
  'settings-ai-uit': { page: 'settings', mock: { aiOff: true }, prepare: '[data-settings-tab="ai"]' },
  'report-updating': {
    page: 'report', statsReportId: seed.aiReports[0].id,
    prepare: ['.aire-chat-toggle', { fill: '.aire-composer textarea', value: 'Zet er vorig jaar naast' }, '.aire-send', '.aire-chat-close'],
  },
  'clients-table': { page: 'clients', storage: { 'resofly.clients.viewMode': 'table' } },
  'projects-table': { page: 'projects', storage: { 'resofly.projects.viewMode': 'table' } },
  'tickets-table': { page: 'tickets', storage: { 'resofly.tickets.view': 'table' } },
  // 2026-11-05 — afgehandelde tickets staan in het archief: dezelfde pagina
  // met de schakelaar Archief aan, in de lijst en in de (telefoon)tabel. Het
  // tabblad Tickets in het klantdossier toont de werklijst met het archief
  // eronder; clients[0] heeft er een van elk in de seed.
  // De weergave expliciet: de opslag van tickets-table hierboven blijft anders
  // in dezelfde browser staan, en dan meet "de lijst" stilletjes de tabel.
  // 2026-11-12 — de schakelaar is nu Actief · Alle · Archief.
  'tickets-archive': { page: 'tickets', storage: { 'resofly.tickets.view': 'list' }, prepare: '.ticket-scope-btn[data-scope="archive"]' },
  'tickets-archive-table': { page: 'tickets', storage: { 'resofly.tickets.view': 'table' }, prepare: '.ticket-scope-btn[data-scope="archive"]' },
  // 2026-11-12 — zoeken en filteren zitten achter een knop. Open mogen ze
  // niet buiten beeld lopen: het zoekveld krijgt op de telefoon een eigen
  // rij, het filterpaneel zijn chips en keuzelijsten.
  'tickets-search': { page: 'tickets', storage: { 'resofly.tickets.view': 'list' }, prepare: ['.ticket-search-toggle', { fill: '.ticket-search input', value: 'website' }] },
  'tickets-filters': { page: 'tickets', storage: { 'resofly.tickets.view': 'list' }, prepare: '.ticket-filter-toggle' },
  'client-tickets': { page: 'client', clientId: seed.clients[0].id, prepare: '.client-tab-btn:has-text("Tickets")' },
  quotes: 'quotes', invoices: 'invoices', contracts: 'contracts', ledger: 'ledger', bank: 'bank', pnl: 'pnl',
  'vat-returns': 'vat-returns', suppliers: 'suppliers', settings: 'settings', 'meeting-booking': 'meeting-booking', archive: 'archive',
  // Instellingen → Boekhouder: de kaart met wat de gast wel en niet ziet staat
  // op de telefoon onder elkaar.
  'settings-boekhouder': { page: 'settings', prepare: '[data-settings-tab="boekhouder"]' },
  // Instellingen → Apps (2026-11-12): ResoFly zelf en de drie losse apps, elk
  // met Openen en Link. Op de telefoon onder elkaar, zonder dat de knoppen eraf vallen.
  'settings-apps': { page: 'settings', prepare: '[data-settings-tab="apps"]' },
  // Instellingen → Logboek (november 2026): de tijdlijn per dag met de
  // filters erboven; op de telefoon de velden achter één knop.
  'settings-logboek': { page: 'settings', prepare: '[data-settings-tab="logboek"]' },
  // Instellingen → Huisstijl: de instellingen met het klantportaal als
  // voorbeeld ernaast (op de telefoon eronder), in een iframe.
  'settings-huisstijl': { page: 'settings', prepare: '[data-settings-tab="huisstijl"]' },
  // Instellingen → Documentopmaak: de sleep-editor met het A4-blad. Op de
  // telefoon staat het blad bovenaan en schaalt het mee; de velden en de
  // instellingen staan eronder. De lijst met velden blijft vanaf de
  // tabletbreedte in beeld (sticky) en mag daarbij nooit over de
  // instellingen schuiven: op een laptop lagen Dupliceren, Verwijderen en de
  // kleurknoppen eronder.
  'settings-documenten': { page: 'settings', prepare: '[data-settings-tab="documenten"]', apart: ['.dle-palette', '.dle-panel'] },
  // Instellingen → Agenda: koppelingen met hun status, de uitleg eronder en de
  // knop "Opnieuw koppelen" (november 2026), naast elkaar of onder elkaar.
  'settings-agenda': { page: 'settings', prepare: '[data-settings-tab="agenda"]' },
  // Instellingen → Agenda → Delen buiten ResoFly (november 2026): het venster
  // met een net gemaakte deellink (een lang adres met kopieerknop), de stappen
  // voor Google, Outlook en Apple, en de lijst met links.
  'settings-agenda-delen': {
    page: 'settings',
    prepare: ['[data-settings-tab="agenda"]', 'button:has-text("Delen buiten ResoFly")', { fill: '.feed-link-form input', value: 'Assistent' }, '.feed-link-form button:has-text("Link maken")'],
  },
  // Instellingen → E-mail: de e-mailteksten met het voorbeeld, waarin sinds
  // november 2026 ook het logo staat zoals bovenaan de mail.
  'settings-email': { page: 'settings', prepare: '[data-settings-tab="email"]' },
  // Instellingen → Betalen: de Mollie-koppeling met het profiel (een lange naam
  // en website) en de waarschuwing voor de testmodus (november 2026).
  'settings-betalen': { page: 'settings', prepare: '[data-settings-tab="betalen"]' },
  // Instellingen → Domein (november 2026): het webadres, een eigen domein dat
  // nog op het record wacht (lange hostnaam, CNAME en TXT met kopieerknoppen,
  // de stappen per provider) en een verhuisd domein. De langste stand.
  'settings-domein': { page: 'settings', prepare: '[data-settings-tab="domein"]' },
  // Instellingen → AI (november 2026): het adres van de connector met
  // kopieerknop, de keuze tussen vijf AI-apps met hun stappen, en de
  // koppelingen. Stond tot nu toe niet in deze test; de lange URL in een
  // smalle kaart is precies wat zijwaarts uit beeld kan lopen.
  'settings-ai': { page: 'settings', prepare: '[data-settings-tab="ai"]' },
  // Boekhouding → Beginbalans met het paneel "Overstappen van een ander
  // pakket?" (auditfile inlezen, 11 november 2026) boven de handmatige regels.
  'ledger-beginbalans': { page: 'ledger', mock: { ledger: true }, prepare: '.bk-tabs button:has-text("Beginbalans")' },
  // Vooruitbetaalde kosten (2026-11-11): de lijst met de balk "klaar om te
  // boeken", een lopende post met zijn schema, en het formulier voor een
  // nieuwe vooruitbetaling met het voorbeeld van de verdeling.
  prepaid: { page: 'prepaid', mock: { ledger: true, prepaid: true } },
  // Het journaal in het Grootboek heeft naast Memoriaalboeking nu ook de knop
  // Vooruitbetaald; de pagina "ledger" hierboven toont zonder rekeningschema
  // alleen de knop om dat aan te maken.
  'ledger-journaal': { page: 'ledger', mock: { ledger: true } },
  'prepaid-venster': { page: 'prepaid', mock: { ledger: true, prepaid: true }, prepare: '.bk-row' },
  'prepaid-nieuw': {
    page: 'prepaid', mock: { ledger: true, prepaid: true },
    prepare: ['button:has-text("Vooruitbetaling vastleggen")', { fill: '.modal input[type="number"]', value: '1000' }],
  },
  // Instellingen → Gegevens (11 november 2026): alles exporteren, met de twee
  // kolommen "wat erin zit" en "wat er niet in zit". Alleen voor de eigenaar
  // en de beheerders; de mock is eigenaar.
  'settings-gegevens': { page: 'settings', prepare: '[data-settings-tab="gegevens"]' },
  // Wat een klánt op zijn telefoon opent: geen werkruimte-shell, dus geen
  // chrome-grens; wel dezelfde fout- en overloopcontrole.
  'public-quote': { path: '/quote/demo-token' },
  'public-invoice': { path: '/invoice/demo-token' },
  'public-contract': { path: '/contract/demo-token' },
  'public-booking': { path: '/booking/demo-token' },
  'public-share': { path: '/gedeeld/demo-token' },
  'public-gallery': { path: '/gallerij/demo-token' },
  // 2026-11-10 — de afmeldpagina voor marketingmail (de link uit een campagne).
  'public-unsubscribe': { path: '/afmelden?token=demo-token' },
  'portal-login': { path: '/portal', mustShow: [PORTAL_CREDIT] },
  // 2026-11-05 — het inlogscherm op het eigen adres van de leverancier, met
  // eigen kleuren voor achtergrond, kaart en knop (zie tests/mobile/mock).
  'portal-login-brand': { path: '/portal/studio-lopik-k7x2m6qp4r', mustShow: [PORTAL_CREDIT] },
  portal: { path: '/portal', portal: true, mustShow: [PORTAL_CREDIT] },
  // 2026-11-12 — het portaal met het logo van de leverancier: groot in de kop,
  // op een licht plaatje (donkere letters vallen weg op de donkere kop), en
  // onderaan nog altijd dat het platform van ResoFly komt.
  'portal-logo': { path: '/portal', portal: true, mock: { portalLogo: true }, mustShow: [PORTAL_LOGO_ON_PLATE, PORTAL_CREDIT] },
  'portal-login-logo': { path: '/portal/studio-lopik-k7x2m6qp4r', mock: { portalLogo: true }, mustShow: [{ selector: '.portal-login-brand .brand-logo img', label: 'het logo op de inlogkaart' }, PORTAL_CREDIT] },
  // Het tabblad Tickets, met een afgehandeld ticket in het blok "Afgehandeld"
  // onderaan (2026-11-05).
  'portal-tickets': { path: '/portal', portal: true, prepare: '.portal-tab:has-text("Tickets")' },
  // Via de deeplink uit de meldingsmail, zoals een klant er ook binnenkomt.
  'portal-messages': { path: '/portal?view=berichten', portal: true },
  'portal-settings': { path: '/portal?view=instellingen', portal: true },
  // 2026-11-11 — de afspraken via een boekingslink, geopend via ?view=afspraken.
  'portal-appointments': { path: '/portal?view=afspraken', portal: true },
  // 2026-11-10 — een klant op inactief: geen tab Tickets, Berichten op de plek
  // van "Open tickets", en bij Instellingen alleen de uitleg over tickets.
  'portal-inactief': { path: '/portal', portal: true, mock: { portalInactive: true } },
  'portal-inactief-settings': { path: '/portal?view=instellingen', portal: true, mock: { portalInactive: true } },
  // Het voorbeeld dat Instellingen → Huisstijl in een iframe toont: het echte
  // portaal op verzonnen gegevens, zonder sessie. Los geopend moet het net zo
  // goed staan als het portaal zelf.
  'portal-preview': { path: '/portal/voorbeeld', mustShow: [PORTAL_CREDIT] },
  login: { path: '/', login: true },
  // 2026-11-12 — de losse apps: dezelfde werkruimte op een eigen adres, met
  // alleen de pagina's van die app in het menu en in de duimbalk. Op de pagina
  // waar hij na installeren opent (de tabbladen van de app staan apart).
  'app-agenda': { path: '/app/agenda/', app: 'agenda', page: 'calendar' },
  'app-financien': { path: '/app/financien/', app: 'financien', page: 'invoices' },
  'app-communicatie': { path: '/app/communicatie/', app: 'communicatie', page: 'communication' },
  // De hele werkruimte als app (/app/werkruimte/): zelfde menu en tabbladen als
  // op "/". Hij kreeg een eigen adres, anders kon Android er geen andere app
  // naast zetten.
  'app-werkruimte': { path: '/app/werkruimte/', app: 'werkruimte', page: 'dashboard' },
  // 2026-11-07 — de inrichtingsstappen, elk op elk formaat. Het abonnement met
  // een gekozen BV: dat is de langste stand (de drie stappen, de pakketten,
  // de modules). Het wachtscherm is wat een teamlid ziet.
  'inrichten-welkom': setupPage('welkom'),
  'inrichten-rechtsvorm': setupPage('rechtsvorm'),
  'inrichten-abonnement': setupPage('abonnement', { pendingLegalForm: 'bv' }),
  'inrichten-bedrijf': setupPage('bedrijf'),
  // Het webadres kiezen, met de controle of de naam nog vrij is (2026-11-08).
  'inrichten-webadres': setupPage('webadres'),
  'inrichten-btw': setupPage('btw'),
  'inrichten-huisstijl': setupPage('huisstijl'),
  'inrichten-facturen': setupPage('facturen'),
  'inrichten-mollie': setupPage('mollie'),
  'inrichten-klaar': setupPage('klaar'),
  'inrichten-wachten': { page: 'dashboard', mock: { onboarding: true, role: 'member' }, shell: '.onb-pending' },
};

/**
 * Het eerste échte item per pagina en hoe laag het hooguit mag beginnen
 * (px vanaf de bovenrand van het scherm). De grenzen liggen zo'n 20% boven
 * de meting van 2026-09-13; een nieuwe kop of knoppenrij erboven trekt de
 * test rood. Alleen voor de telefoon: daar is de ruimte het schaarst.
 *
 * 2026-09-19 — het kruimelpad staat sindsdien boven elke pagina-inhoud en kost
 * op de telefoon 36px (regel van 28px + 8px marge). De grenzen hieronder gingen
 * daarom met datzelfde bedrag omhoog, zodat de speling tegen ongemerkte groei
 * blijft wat hij was. Niet opgehoogd: het dashboard (staat bovenaan het pad en
 * heeft er dus geen), de schermvullende pagina's zonder kruimelpad (agenda,
 * weekplanner, teamchat, Berichten) en alles buiten de werkruimte.
 */
const FIRST_ITEM = {
  dashboard: { selector: '.dash-task', maxTop: 280 },
  // De klantenlijst toont boven de kaarten de tabstrook "Klanten | Niet
  // gekoppeld" zodra er post in de opvangbak ligt — en dat ligt er in de seed
  // (twee berichten). Die strook telde tot 2026-09-17 nooit mee: de mock gaf
  // de teller niet door (content-range viel weg door CORS), dus de strook bleef
  // verborgen. Gemeten mét strook: kaarten 274px, tabel 303px.
  clients: { selector: '.client-card', maxTop: 366 },
  'clients-table': { selector: '.clients-table tbody tr', maxTop: 401 },
  projects: { selector: '.project-list-card', maxTop: 321 },
  'projects-table': { selector: '.projects-table tbody tr', maxTop: 346 },
  marketing: { selector: '.mk-campaign-table tbody tr', maxTop: 366 },
  // 2026-11-12 — zoeken en filteren zitten achter een knop in de werkbalk; de
  // vaste zoekkaart erboven is weg. Gemeten: lijst 226px, tabel 262px,
  // archief 306px en archieftabel 342px. De grenzen gingen mee omlaag en
  // liggen weer 20% hoger, zodat die kaart niet ongemerkt terugkomt.
  tickets: { selector: '.ticket-item', maxTop: 272 },
  // 2026-09-22 — de tabelweergave is op de telefoon een eigen, smalle tabel
  // (.tk-ctable) in plaats van een kaartstapel. Gemeten: eerste rij op 310px
  // (de kolomkop van 34px zit erboven); de grens ligt 20% hoger. Op de tablet
  // staat de brede tabel en telt deze regel niet.
  'tickets-table': { selector: '.tk-ctable tbody tr', maxTop: 315 },
  // 2026-11-05 — het archief van tickets, het tabblad Tickets in het
  // klantdossier en dat in het portaal. Gemeten: 355px (de uitleg boven het
  // archief kost op de telefoon drie regels), 391px, 670px (kop, kerncijfers,
  // tabbladen en zoekbalk van het dossier gaan voor) en 170px. De grenzen
  // liggen 20% hoger.
  'tickets-archive': { selector: '.ticket-item', maxTop: 368 },
  'tickets-archive-table': { selector: '.tk-ctable tbody tr', maxTop: 411 },
  'client-tickets': { selector: '.client-ticket-list .ticket-item', maxTop: 804 },
  'portal-tickets': { selector: '.portal-row', maxTop: 204 },
  invoices: { selector: '.quote-table tbody tr', maxTop: 496 },
  quotes: { selector: '.quote-table tbody tr', maxTop: 496 },
  weekplanner: { selector: '.wp-daystrip', maxTop: 600 },
  calendar: { selector: '.tb-scroll', maxTop: 260 },
  // De eerste weekrij van de maand. Gemeten 2026-11-13: 168px; de grens ligt 20% hoger.
  'calendar-month': { selector: '.cm-week', maxTop: 202 },
  time: { selector: '.tt-kpi', maxTop: 396 },
  client: { selector: '.client-tabs-bar', maxTop: 516 },
  project: { selector: '.client-tabs-bar', maxTop: 496 },
  'project-planning': { selector: '.ptl-board', maxTop: 496 },
  content: { selector: '.odrv-tr', maxTop: 336 },
  // Teamchat opent op de telefoon in de gesprekslijst (één venster tegelijk).
  // Bovenaan je avatar en de keuzestrook (Activiteit · Chat · Kanalen ·
  // Bestanden · Opgeslagen, sinds 2026-11-12 in de huisstijl van ResoFly), dan
  // de kop en het zoekveld. Het eerste gesprek is een .tmc-row; de grens
  // blijft 260px (gemeten: 235px).
  chat: { selector: '.tmc-row', maxTop: 260 },
  // Berichten: idem. De balk met zoeken, filters en tabbladen is in twee
  // stappen gekrompen — eerst door hem bovenaan te zetten en de werkbalk van
  // de app hier weg te laten (206px), daarna door de titel aan de tabstrook
  // over te laten en de filters als paneel te laten zweven (151px). De grens
  // volgt mee, anders meet deze test niets meer.
  communication: { selector: '.comm-row', maxTop: 185 },
  // De losse apps openen op dezelfde pagina's met dezelfde balken: dezelfde grenzen.
  'app-agenda': { selector: '.tb-scroll', maxTop: 260 },
  'app-financien': { selector: '.quote-table tbody tr', maxTop: 496 },
  'app-communicatie': { selector: '.comm-row', maxTop: 185 },
  'app-werkruimte': { selector: '.dash-task', maxTop: 280 },
  suppliers: { selector: '.supplier-table tbody tr', maxTop: 356 },
  // 2026-11-12 — Gerrie → Gesprekken: kop van Gerrie, de vijf tabbladen, de
  // titel met "Nieuw gesprek" en het zoekveld gaan voor het eerste gesprek.
  // Gemeten: 356px (licht en donker); de grens ligt 20% hoger.
  'gerrie-gesprekken': { selector: '.gsp-item', maxTop: 427 },
  // 2026-11-11 — vooruitbetaalde kosten: de balk "klaar om te boeken" en twee
  // kerncijfers gaan voor. Gemeten: 435px (licht en donker); de grens ligt 20%
  // hoger.
  prepaid: { selector: '.bk-prepaid-list tbody tr', maxTop: 522 },
  'public-quote': { selector: '.public-lines', maxTop: 560 },
  'public-invoice': { selector: '.public-lines', maxTop: 700 },
  'public-booking': { selector: '.booking-slot', maxTop: 360 },
  portal: { selector: '.portal-row', maxTop: 380 },
  'portal-logo': { selector: '.portal-row', maxTop: 380 },
  // Zelfde opbouw als het portaal, alleen zonder tab Tickets.
  'portal-inactief': { selector: '.portal-row', maxTop: 380 },
  // 2026-10-04 — Berichten en Instellingen in het portaal, geopend via de
  // deeplink uit de meldingsmail. Gemeten: eerste gesprek 204px, eerste
  // schakelaar 267px; de grenzen liggen zo'n 20% hoger.
  'portal-messages': { selector: '.portal-conv', maxTop: 245 },
  'portal-settings': { selector: '.portal-toggle-row', maxTop: 320 },
  // 2026-11-11 — Afspraken in het portaal, geopend via ?view=afspraken: de
  // eerste afspraak staat net onder de tabbladen. Gemeten: 150px (licht en
  // donker); de grens ligt 20% hoger.
  'portal-appointments': { selector: '.portal-appointment', maxTop: 180 },
  // 2026-11-07 — de inrichtingsstappen: de kop van de stap staat onder de
  // stappenkop (merk met Uitloggen, voortgang, bolletjes). Gemeten: 215px bij
  // elke stap, licht en donker; de grens ligt 20% hoger.
  ...Object.fromEntries(SETUP_ORDER.map(step => [`inrichten-${step}`, { selector: '.onb-title', maxTop: 258 }])),
};

/**
 * Zenit (designvoorstel 2026-10-22) zet op Vandaag de dag zelf bovenaan: de
 * Dagboog met Nu en Volgende. Daar is die boog het eerste échte item, niet de
 * eerste taak. Gemeten 2026-10-23: de boog begint op 58px (Dag en Nacht); de
 * grens ligt 20% hoger. De rest van de pagina's houdt de grenzen van Cockpit.
 */
const FIRST_ITEM_BY_LOOK = {
  zenit: { dashboard: { selector: '.zarc', maxTop: 70 } },
  // Stroom (designvoorstel 2026-10-30): op Vandaag is de stroom het eerste
  // échte item, direct onder de groet (op de telefoon staat Nu eronder).
  // Gemeten 2026-10-30: 152px in Dag en Nacht; de grens ligt 20% hoger.
  stroom: { dashboard: { selector: '.sl-flow', maxTop: 185 } },
};

const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] ?? 'true'] : [a, 'true']; }));
const themes = args.theme === 'both' ? ['dark', 'light'] : [args.theme === 'light' ? 'light' : 'dark'];
// Liggend hoort in de standaardronde. De fix van 18 september op Berichten
// voegde het formaat toe aan VIEWPORTS en beschreef het als "in de
// standaardronde", maar deze regel bleef op 'phone,tablet' staan — dus werd de
// band 761-900px nooit gemeten, en dat is precies waar een gekantelde telefoon
// zit: geen smal scherm maar een laag scherm, een heel ander probleem.
const viewports = (args.viewports ?? 'phone,tablet,landscape,laptop').split(',').map(v => v.trim()).filter(v => VIEWPORTS[v]);
const pages = args.pages ? args.pages.split(',').map(p => p.trim()).filter(p => PAGES[p]) : Object.keys(PAGES);
// Zonder --look meet de test de standaardlook (Baken, niets in de opslag);
// Cockpit, Zenit en Stroom staan als keuze in de opslag (src/lib/look.ts).
const look = args.look === 'cockpit' || args.look === 'zenit' || args.look === 'stroom' ? args.look : null;
const firstItem = { ...FIRST_ITEM, ...(look ? FIRST_ITEM_BY_LOOK[look] : {}) };
const shotsDir = args.shots ? path.resolve(args.shots) : null;
if (shotsDir) fs.mkdirSync(shotsDir, { recursive: true });

// ── Dev-server ────────────────────────────────────────────────────────────
process.env.VITE_SUPABASE_URL ??= 'https://example.supabase.co';
process.env.VITE_SUPABASE_ANON_KEY ??= 'mock-anon-key-for-layout-test';
process.env.VITE_R2_WORKER_URL ??= 'https://media.example.test';
// Staging heeft een agendaserver: dan staan de stappen voor de telefoon en de
// knop "Delen buiten ResoFly" in beeld (src/lib/caldavSetup.ts).
process.env.VITE_APP_ENV ??= 'staging';
let server = null;
let baseUrl = args.url;
if (!baseUrl) {
  server = await createServer({ configFile: path.join(ROOT, 'vite.config.ts'), root: ROOT, logLevel: 'silent', server: { port: 5199, strictPort: false, host: '127.0.0.1' } });
  await server.listen();
  baseUrl = server.resolvedUrls.local[0];
}

// ── Meten ─────────────────────────────────────────────────────────────────
const failures = [];
const rows = [];
const browser = await chromium.launch({ headless: true, executablePath: process.env.RESOFLY_CHROMIUM || undefined });
try {
  for (const theme of themes) {
    for (const vpName of viewports) {
      const vp = VIEWPORTS[vpName];
      const context = await browser.newContext({ viewport: vp.viewport, deviceScaleFactor: vp.deviceScaleFactor, isMobile: vp.isMobile, hasTouch: vp.hasTouch, locale: 'nl-NL', timezoneId: 'Europe/Amsterdam', colorScheme: theme, reducedMotion: 'reduce' });
      await installMock(context);
      for (const key of pages) {
        if (vp.only && !vp.only.includes(key)) continue;
        const spec = PAGES[key];
        // Een pagina met een eigen backend (de inrichting van een nieuwe
        // organisatie) krijgt een eigen context; de rest deelt er een.
        const ownContext = typeof spec === 'object' && spec.mock
          ? await browser.newContext({ viewport: vp.viewport, deviceScaleFactor: vp.deviceScaleFactor, isMobile: vp.isMobile, hasTouch: vp.hasTouch, locale: 'nl-NL', timezoneId: 'Europe/Amsterdam', colorScheme: theme, reducedMotion: 'reduce' })
          : null;
        if (ownContext) await installMock(ownContext, spec.mock);
        const page = await (ownContext ?? context).newPage();
        const errors = [];
        page.on('pageerror', e => errors.push(String(e.message)));
        // Een losse app (spec.app) heeft een eigen adres maar is de werkruimte.
        const isPublic = typeof spec === 'object' && spec.path && !spec.app;
        await page.addInitScript(storageScript(spec, { 'resofly.theme': theme, ...(look ? { 'resofly.look': look } : {}), ...(spec.storage ?? {}) }));
        await page.goto(typeof spec === 'object' && spec.path ? new URL(spec.path, baseUrl).href : baseUrl, { waitUntil: 'networkidle' });
        // Werkruimte: de shell; publieke pagina: de eigen wortel; de inrichting: zijn eigen scherm.
        const shell = await page.waitForSelector(spec.shell ?? (isPublic ? '.public-quote-page, .portal, .galv, .login, .pgal' : '.app'), { timeout: 20000 }).catch(() => null);
        await page.waitForTimeout(isPublic ? 1200 : 700);
        // Een pagina die pas in een bepaalde stand krap wordt (een uitgeklapt
        // filterpaneel) zet die stand hier zelf aan. Staat de knop er niet op
        // dit formaat, dan gebeurt er niets.
        // Meerdere stappen kan ook (2026-11-10): een lijst met selectors om op te
        // klikken, of { fill, value } om een veld in te vullen. Zo opent de test
        // het gesprek, typt een vraag en verstuurt die.
        for (const step of spec.prepare ? [spec.prepare].flat() : []) {
          const knop = page.locator(typeof step === 'string' ? step : step.fill).first();
          if (!(await knop.isVisible().catch(() => false))) continue;
          if (typeof step !== 'string') { await knop.fill(step.value); continue; }
          // De muis van de testbrowser staat op (0,0); op tabletformaat klapt
          // de niet-vastgezette zijbalk daardoor open over de eerste
          // agendakolom en vangt hij de klik af. Een echte tablet heeft geen
          // hover — dan gaat de klik rechtstreeks naar het element.
          await knop.click({ timeout: 3000 }).catch(() => knop.dispatchEvent('click'));
          await page.waitForTimeout(250);
        }
        const m = await page.evaluate((firstSel) => {
          const box = (sel) => { const el = document.querySelector(sel); if (!el) return 0; const cs = getComputedStyle(el); if (cs.display === 'none') return 0; return Math.round(el.getBoundingClientRect().height); };
          const content = document.querySelector('.content:not([hidden])');
          const first = firstSel ? document.querySelector(`.content:not([hidden]) ${firstSel}`) : null;
          return {
            chrome: box('.topbar') + box('.tabbar') + box('.bottomnav'),
            firstTopDoc: (firstSel && document.querySelector(firstSel)) ? Math.round(document.querySelector(firstSel).getBoundingClientRect().top) : null,
            pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
            contentOverflow: content ? content.scrollWidth - content.clientWidth : 0,
            firstTop: first ? Math.round(first.getBoundingClientRect().top) : null,
            // Is het eerste item ook écht te zién? Een kop of filterbalk die
            // te hoog wordt, kan de lijst tot nul samendrukken terwijl er
            // verder niets opvalt: geen fout, geen zijwaartse overloop, en de
            // chrome-meting telt alleen de vaste balken. We scrollen het item
            // dus eerst in beeld (ook binnen een eigen scrollgebied) en
            // knippen zijn rechthoek daarna bij op élke voorouder die
            // afkapt. Blijft er niets over, dan is het item onbereikbaar.
            firstVisible: first ? (() => {
              first.scrollIntoView({ block: 'center', inline: 'nearest' });
              const r = first.getBoundingClientRect();
              let top = r.top;
              let bottom = r.bottom;
              for (let p = first.parentElement; p; p = p.parentElement) {
                const cs = getComputedStyle(p);
                if (cs.overflowY === 'visible' && cs.overflowX === 'visible') continue;
                const pr = p.getBoundingClientRect();
                top = Math.max(top, pr.top);
                bottom = Math.min(bottom, pr.bottom);
              }
              return Math.round(Math.max(0, Math.min(bottom, window.innerHeight) - Math.max(top, 0)));
            })() : null,
          };
        }, firstItem[key]?.selector ?? null);
        // Publieke pagina's en de inrichting hebben geen .content-wikkel: meet daar op het document.
        if ((isPublic || spec.shell) && m.firstTop == null) m.firstTop = m.firstTopDoc;
        // Twee delen die naast elkaar horen, gemeten over de hele scrollhoogte.
        // Een plakkend (sticky) deel schuift pas ergens overheen als je naar
        // beneden scrolt; bovenaan, waar de andere metingen kijken, is er dan
        // niets aan de hand. Daarna terug naar waar de pagina stond, zodat een
        // screenshot hetzelfde laat zien als zonder deze meting.
        const overlap = spec.apart ? await page.evaluate(async ([a, b]) => {
          const scroller = document.querySelector('.content:not([hidden])') ?? document.scrollingElement;
          const start = scroller.scrollTop;
          const max = scroller.scrollHeight - scroller.clientHeight;
          let worst = 0;
          for (let step = 0; step <= 10; step++) {
            scroller.scrollTop = Math.round((max * step) / 10);
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const ra = document.querySelector(a)?.getBoundingClientRect();
            const rb = document.querySelector(b)?.getBoundingClientRect();
            if (!ra || !rb) continue;
            const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
            const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
            if (w > 1 && h > 1) worst = Math.max(worst, Math.round(w * h));
          }
          scroller.scrollTop = start;
          return worst;
        }, spec.apart) : 0;
        const missing = spec.mustShow ? await page.evaluate((wanted) => wanted.filter(({ selector, text }) => {
          const el = document.querySelector(selector);
          if (!el) return true;
          const r = el.getBoundingClientRect();
          if (r.width < 1 || r.height < 1 || getComputedStyle(el).visibility === 'hidden') return true;
          return Boolean(text) && !el.textContent.replace(/\s+/g, ' ').includes(text);
        }).map(({ label }) => label), spec.mustShow) : [];
        const label = `${look ? `${look}/` : ''}${theme}/${vpName}/${key}`;
        const problems = [];
        for (const what of missing) problems.push(`${what} ontbreekt`);
        if (!shell) problems.push(isPublic ? 'pagina niet gerenderd' : 'app-shell niet gerenderd');
        if (errors.length) problems.push(`js-fout: ${errors[0].slice(0, 90)}`);
        if (m.pageOverflow > 1 || m.contentOverflow > 1) problems.push(`horizontale overloop (${Math.max(m.pageOverflow, m.contentOverflow)}px)`);
        if (m.chrome > vp.maxChrome) problems.push(`chrome ${m.chrome}px > ${vp.maxChrome}px`);
        if (overlap) problems.push(`${spec.apart[0]} schuift over ${spec.apart[1]} (${overlap}px²)`);
        // Bereikbaarheid geldt op élk formaat — juist liggend, waar de hoogte
        // schaars is, gaat dit mis. 12px is ruim onder een normale regel en
        // ruim boven het gerommel van een afrondingsfout.
        if (firstItem[key] && m.firstVisible != null && m.firstVisible < 12) {
          problems.push(`eerste item (${firstItem[key].selector}) is weggedrukt: ${m.firstVisible}px zichtbaar`);
        }
        const rule = vpName === 'phone' ? firstItem[key] : null;
        if (rule) {
          if (m.firstTop == null) problems.push(`eerste item (${rule.selector}) niet gevonden`);
          else if (m.firstTop > rule.maxTop) problems.push(`eerste item op ${m.firstTop}px > ${rule.maxTop}px`);
        }
        rows.push({ label, chrome: m.chrome, firstTop: m.firstTop, max: rule?.maxTop ?? null, problems });
        if (problems.length) failures.push({ label, problems });
        if (shotsDir) await page.screenshot({ path: path.join(shotsDir, `${look ? `${look}-` : ''}${theme}-${vpName}-${key}.png`) });
        await page.close();
        if (ownContext) await ownContext.close();
      }
      await context.close();
    }
  }
} finally {
  await browser.close();
  if (server) await server.close();
}

// ── Verslag ───────────────────────────────────────────────────────────────
for (const r of rows) {
  const first = r.firstTop == null ? '' : `eerste item ${String(r.firstTop).padStart(4)}px${r.max ? ` (max ${r.max})` : ''}`;
  console.log(`${r.problems.length ? 'FAIL' : ' ok '} ${r.label.padEnd(30)} chrome ${String(r.chrome).padStart(3)}px  ${first}${r.problems.length ? '  ← ' + r.problems.join('; ') : ''}`);
}
console.log(`\n${rows.length} pagina's gemeten, ${failures.length} met problemen.`);
process.exit(failures.length ? 1 : 0);
