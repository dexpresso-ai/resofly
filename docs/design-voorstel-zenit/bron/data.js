/* ══ Voorbeeldgegevens ══════════════════════════════════════════════════════
   Uit de testomgeving (tests/mobile/mock/seed.mjs): Studio Lopik en haar
   klanten. De demo speelt op donderdag 22 oktober 2026, week 43, in Lopik. */
const DEMO = { y: 2026, m: 9, d: 22, now: 9 * 60 + 41, lat: 51.97, lon: 4.94, tz: 2, week: 43 };
const NEUTRAL = '#9C9A94';

const CLIENTS = {
  korenaar: { name: 'Bakkerij De Korenaar', short: 'De Korenaar', code: 'K-1001', contact: 'Joost Vermeer', role: 'Eigenaar', email: 'joost@bakkerij.nl', phone: '06-1234 5610', addr: 'Dorpsstraat 10, 3410 AB Lopik', color: '#FFD966', ini: 'BK', status: 'Actief', tags: ['retail', 'huisstijl'], value: 18500 },
  fysio: { name: 'Fysio Centrum Zuid', short: 'Fysio Zuid', code: 'K-1002', contact: 'Maria Jansen', color: '#34D399', ini: 'FZ', status: 'Actief', value: 9200 },
  vandijk: { name: 'Van Dijk Installatietechniek', short: 'Van Dijk', code: 'K-1003', contact: 'Peter van Dijk', color: '#60A5FA', ini: 'VD', status: 'Actief', value: 24000 },
  zonnetje: { name: 'Kinderopvang Zonnetje', short: 'Zonnetje', code: 'K-1004', contact: 'Els de Boer', color: '#F472B6', ini: 'KZ', status: 'Prospect', value: 4000 },
  bloem: { name: 'Restaurant Bloem', short: 'Bloem', code: 'K-1005', contact: 'Karim El Amrani', email: 'karim@restaurant.nl', color: '#FF9F43', ini: 'RB', status: 'Actief', value: 6600 },
  hendriks: { name: 'Notariskantoor Hendriks', short: 'Hendriks', code: 'K-1006', contact: 'Willem Hendriks', color: '#A78BFA', ini: 'NH', status: 'Inactief', value: 12000 },
};

const PROJECTS = {
  huisstijl: { name: 'Nieuwe huisstijl De Korenaar', client: 'korenaar', color: '#FFD966' },
  fysioweb: { name: 'Website Fysio Centrum Zuid', client: 'fysio', color: '#34D399' },
  winter: { name: 'Campagne winteractie Van Dijk', client: 'vandijk', color: '#60A5FA' },
  menukaart: { name: 'Menukaart & social Bloem', client: 'bloem', color: '#FF9F43' },
  zonnetje: { name: 'Onboarding Zonnetje', client: 'zonnetje', color: '#F472B6' },
};

// Vandaag: afspraken (meet/call) en focusblokken (ingeplande taken)
const TODAY = [
  { s: 525, e: 540, t: 'Dagstart met Sanne en Daan', short: 'Dagstart', kind: 'meet', where: 'Studio', c: NEUTRAL },
  { s: 540, e: 595, t: 'Logo-schetsen uitwerken', short: 'Logo-schetsen', kind: 'focus', p: 'huisstijl' },
  { s: 600, e: 660, t: 'Overleg Joost — kleurenpalet', short: 'Overleg Joost', kind: 'meet', p: 'huisstijl', where: 'Video via Jitsi', join: 'video' },
  { s: 675, e: 750, t: 'Menukaart drukklaar maken', short: 'Menukaart', kind: 'focus', p: 'menukaart' },
  { s: 810, e: 870, t: 'Kennismaking Zonnetje', short: 'Zonnetje', kind: 'meet', p: 'zonnetje', where: 'Kinderopvang Zonnetje, Lopik', join: 'route' },
  { s: 900, e: 960, t: 'Offerte opstellen Zonnetje', short: 'Offerte', kind: 'focus', p: 'zonnetje' },
  { s: 990, e: 1005, t: 'Terugbellen Peter van Dijk', short: 'Peter', kind: 'call', p: 'winter', where: 'Telefoon', join: 'call' },
  { s: 1020, e: 1050, t: 'Uren en dagafsluiting', short: 'Afsluiten', kind: 'focus', c: NEUTRAL },
];

const TASKS = [
  { id: 't1', t: 'Terugbellen Peter over planning', p: 'winter', est: 15, when: '1 d te laat', cls: 'late', group: 'late' },
  { id: 't2', t: 'Logo-schetsen uitwerken', p: 'huisstijl', est: 120, when: 'Bezig', cls: 'today', group: 'today' },
  { id: 't3', t: 'Kleurenpalet afstemmen met Joost', p: 'huisstijl', est: 60, when: '10:00', group: 'today' },
  { id: 't4', t: 'Menukaart drukklaar maken', p: 'menukaart', est: 90, when: 'Deadline vandaag', cls: 'today', group: 'today' },
  { id: 't5', t: 'Kennismakingsgesprek voorbereiden', p: 'zonnetje', est: 45, when: 'vóór 13:30', group: 'today' },
  { id: 't6', t: 'Offerte opstellen Zonnetje', p: 'zonnetje', est: 60, when: '15:00', group: 'today' },
  { id: 't7', t: 'Social posts week 43', p: 'winter', est: 90, when: 'klaar 09:12', group: 'today', done: true },
];

// Te beslissen — wat Gerrie en de agents klaarzetten
const DECISIONS = [
  { id: 'd1', icon: 'bell-ring', run: true, agent: 'Debiteurenbewaker', pending: 'Herinnering aan Karim El Amrani', title: 'Herinnering voor factuur 2026-040', why: 'Restaurant Bloem · € 786,50 · 10 dagen te laat. Karim betaalde de vorige twee binnen 2 dagen na een herinnering.', cta: 'Bekijk mail', done: 'Herinnering verstuurd naar Karim El Amrani' },
  { id: 'd2', icon: 'clock', agent: 'Gerrie', title: '3u 15m uren uit je agenda van gisteren', why: 'Werksessie wireframes (2u · Website Fysio) en belafspraak Peter (1u 15m · Van Dijk).', cta: 'Uren bekijken', done: '3u 15m geboekt op twee projecten' },
  { id: 'd3', icon: 'mail', agent: 'Gerrie', pending: 'Opvolgmail aan Peter van Dijk', title: 'Offerte 2026-020 wacht al 9 dagen', why: 'Peter van Dijk opende hem 3× — laatst gisteren om 21:14. Er staat een korte opvolgmail klaar.', cta: 'Bekijk opvolgmail', done: 'Opvolgmail verstuurd naar Peter van Dijk' },
  { id: 'd4', icon: 'receipt', agent: 'Inkoop-inbox', title: '2 inkoopfacturen herkend in je mail', why: 'Adobe (€ 71,39) en Drukkerij Lopik (€ 412,50). Het boekingsvoorstel staat klaar.', cta: 'Controleren', done: '2 inkoopfacturen geboekt' },
];

const DDETAIL = {
  d1: {
    sub: 'Debiteurenbewaker · draait elke werkdag om 08:30 · namens jou',
    facts: [['Vervallen op', '12 okt · 10 dagen'], ['Bedrag', '€ 786,50'], ['Vorige keren', '2× betaald binnen 2 dagen']],
    kind: 'mail', to: 'Karim El Amrani &lt;karim@restaurant.nl&gt;', subj: 'Herinnering: factuur 2026-040 (€ 786,50)',
    body: ['Hoi Karim,', 'Een vriendelijke herinnering: factuur <mark>2026-040</mark> voor de content van september (<mark>€ 786,50</mark>) stond op <mark>12 oktober</mark> open. Misschien is hij tussen de drukte door geschoten. Via de link hieronder betaal je hem direct met iDEAL.', 'Groet,<br>Gerjan — Studio Lopik'],
  },
  d2: {
    sub: 'Gerrie · uit je agenda van woensdag 21 oktober',
    facts: [['Gevonden', '2 afspraken'], ['Samen', '3u 15m'], ['Declarabel', '€ 276,25']],
    kind: 'hours', rows: [['Werksessie wireframes', 'Website Fysio Centrum Zuid', 'wo 13:00 – 15:00', '2u'], ['Belafspraak Peter van Dijk', 'Campagne winteractie Van Dijk', 'wo 15:30 – 16:45', '1u 15m']],
  },
  d3: {
    sub: 'Gerrie · signaal uit de offerte-mail (geopend, niet beantwoord)',
    facts: [['Verstuurd', '13 okt · 9 dagen'], ['Bedrag', '€ 3.327,50'], ['Geopend', '3× · gisteren 21:14']],
    kind: 'mail', to: 'Peter van Dijk &lt;peter@van.nl&gt;', subj: 'Offerte winteractie — nog vragen?',
    body: ['Hoi Peter,', 'Ik zag dat je de offerte voor de <mark>winteractie</mark> nog eens hebt bekeken. Zullen we de planning even doorlopen? Ik bel je vanmiddag om <mark>16:30</mark> toch al; dan kunnen we het meteen meenemen.', 'Groet,<br>Gerjan — Studio Lopik'],
  },
  d4: {
    sub: 'Inkoop-inbox · uit facturen@studiolopik.nl',
    facts: [['Herkend', '2 facturen'], ['Totaal', '€ 483,89'], ['Btw terug', '€ 83,98']],
    kind: 'purchase', rows: [['Adobe Systems', 'Software · 4610', '€ 71,39'], ['Drukkerij Lopik', 'Drukwerk De Korenaar · 7000', '€ 412,50']],
  },
};

const TEAM_DECISIONS = [
  { icon: 'life-buoy', owner: 'Sanne', agent: 'Ticketwacht', title: 'Antwoord op ticket "Website laadt traag op mobiel"', why: 'Fysio Centrum Zuid · concept klaar' },
  { icon: 'megaphone', owner: 'Daan', agent: 'Socialplanner', title: 'Social posts week 44 inplannen', why: '6 posts voor Van Dijk en Bloem' },
];

const AGENTS = [
  { icon: 'bell-ring', run: true, name: 'Debiteurenbewaker', when: 'Elke werkdag 08:30', st: '1 voorstel open' },
  { icon: 'sunrise', run: true, name: 'Ochtendbriefing', when: 'Elke werkdag 08:00', st: 'Vandaag 08:00 klaar' },
  { icon: 'inbox', run: true, name: 'Inkoop-inbox', when: 'Bij elke nieuwe mail', st: '1 voorstel open' },
  { icon: 'clock', name: 'Urencheck op vrijdag', when: 'Vrijdag 16:00', st: 'Volgende run morgen', idle: true },
];

const INVOICES = [
  { n: '2026-042', c: 'zonnetje', d: 'Onboarding', date: '—', due: '—', amt: 423.50, st: 'concept' },
  { n: '2026-041', c: 'korenaar', d: 'Huisstijl fase 1', date: '10 okt', due: '28 okt', amt: 2904.00, st: 'open', note: 'Geopend 2×' },
  { n: '2026-040', c: 'bloem', d: 'Content september', date: '12 sep', due: '12 okt', amt: 786.50, st: 'late', note: '10 dagen te laat' },
  { n: '2026-039', c: 'fysio', d: 'Website oplevering', date: '2 okt', due: '16 okt', amt: 6292.00, st: 'paid', note: 'Betaald 21 okt' },
  { n: '2026-038', c: 'vandijk', d: 'Advies (6 uur)', date: '2 sep', due: '16 sep', amt: 617.10, st: 'paid', note: 'Betaald 15 sep' },
  { n: '2026-037', c: 'bloem', d: 'Content augustus', date: '13 aug', due: '27 aug', amt: 786.50, st: 'paid', note: 'Betaald 26 aug' },
];
const INV_ST = { concept: ['Concept', ''], open: ['Openstaand', 'info'], late: ['Te laat', 'danger'], paid: ['Betaald', 'ok'] };

const BOARD = {
  todo: [
    { id: 'k1', t: 'Drukproef briefpapier', est: '45m', due: 'vr 23 okt', who: ['gl'], tags: [['Drukwerk', '']] },
    { id: 'k2', t: 'Huisstijlhandboek opzetten', est: '2u', due: '6 nov', who: ['sb'] },
    { id: 'k3', t: 'Visitekaartjes drukklaar', est: '1u 30m', due: '30 okt', who: ['db'] },
  ],
  doing: [
    { id: 'k4', t: 'Logo-schetsen uitwerken', est: '2u', due: 'Vandaag', who: ['gl'], tags: [['Hoog', 'danger']] },
    { id: 'k5', t: 'Kleurenpalet afstemmen met Joost', est: '1u', due: '10:00', who: ['gl', 'sb'] },
  ],
  review: [
    { id: 'k6', t: 'Logovarianten A, B en C', est: '3u', due: 'wacht op Joost', who: ['sb'], tags: [['3 bijlagen', '']] },
  ],
  done: [
    { id: 'k7', t: 'Moodboard presenteren', est: '1u', due: '9 okt', who: ['sb'] },
    { id: 'k8', t: 'Kick-off en briefing', est: '1u 30m', due: '2 okt', who: ['gl', 'sb'] },
  ],
};
const LANES = [['todo', 'Te doen'], ['doing', 'Bezig'], ['review', 'Review'], ['done', 'Klaar']];
const PEOPLE = { gl: ['GL', ''], sb: ['SB', 'av-sb'], db: ['DB', 'av-db'] };

// Week 43: ma 19 – vr 23 oktober (d = 0..4)
const WEEK = [
  { d: 0, s: 540, e: 570, t: 'Weekstart team', w: 'Studio', c: NEUTRAL },
  { d: 0, s: 600, e: 720, t: 'Wireframes afsprakenmodule', w: 'Focus', c: '#34D399', focus: true },
  { d: 0, s: 810, e: 870, t: 'Kick-off nieuwsbrief november', w: 'Studio', c: '#A78BFA' },
  { d: 1, s: 600, e: 720, t: 'Instagram-reels monteren', w: 'Focus', c: '#FF9F43', focus: true },
  { d: 1, s: 840, e: 900, t: 'Presentatie concept De Korenaar', w: 'Studio', c: '#FFD966' },
  { d: 2, s: 600, e: 690, t: 'Mailing winteractie schrijven', w: 'Focus', c: '#60A5FA', focus: true },
  { d: 2, s: 780, e: 900, t: 'Werksessie wireframes', w: 'Studio', c: '#34D399' },
  { d: 2, s: 930, e: 1005, t: 'Belafspraak Peter van Dijk', w: 'Telefoon', c: '#60A5FA' },
  { d: 4, s: 540, e: 720, t: 'Fotoshoot Bloem', w: 'Restaurant Bloem', c: '#FF9F43' },
  { d: 4, s: 900, e: 960, t: 'Weekafsluiting', w: 'Studio', c: NEUTRAL },
];

// Geldstroom: saldo (ABN AMRO zakelijk) — 30 dagen terug en 30 dagen vooruit
const CASH = {
  now: 14380.22,
  past: [[-30, 10730.22], [-22, 10730.22], [-21, 9480.22], [-17, 9480.22], [-16, 9068.22], [-8, 9068.22], [-7, 8088.22], [-2, 8088.22], [-1, 14380.22], [0, 14380.22]],
  future: [[0, 14380.22, 0], [2, 15166.72, 250, '+ € 786,50', 'Bloem'], [6, 18070.72, 520, '+ € 2.904', 'Korenaar'], [10, 16820.72, 700, '− € 1.250', 'Huur'], [12, 16336.83, 760], [19, 13936.83, 950, '− € 2.400', 'Loon'], [29, 17990.33, 1350, '+ € 4.053', 'Fase 2'], [30, 17990.33, 1400]],
};
const SPARK = [5200, 6100, 4300, 3900, 7800, 6900, 8300, 9100, 7600, 6400, 7400, 9196];

const TIMELINE = [
  { day: 'Vandaag', items: [
    { ic: 'video', cls: 'gold', t: '<b>Overleg Joost — kleurenpalet</b>', s: '10:00 – 11:00 · Video via Jitsi · jij en Sanne', time: '10:00' },
  ] },
  { day: 'Gisteren', items: [
    { ic: 'message-square', t: '<b>Sanne</b> deelde drie logovarianten in de teamchat', s: 'A: het bestaande, iets strakker · B: zonder aar · C: aar als accent op de K', time: '09:31' },
    { ic: 'mail-open', t: 'Joost opende <b>factuur 2026-041</b> voor de tweede keer', s: '€ 2.904,00 · vervalt 28 oktober', time: '16:40' },
  ] },
  { day: 'Dinsdag 20 oktober', items: [
    { ic: 'monitor', t: '<b>Presentatie concept</b> in de studio', s: 'Joost, Sanne en jij · 1 uur', q: '“Richting C voelt het meest als ons. Kunnen we de aar nog iets kleiner?”', time: '14:00' },
  ] },
  { day: 'Zaterdag 10 oktober', items: [
    { ic: 'send', t: '<b>Factuur 2026-041</b> verstuurd', s: 'Huisstijl fase 1 · € 2.904,00', time: '09:05' },
  ] },
  { day: 'Vrijdag 9 oktober', items: [
    { ic: 'circle-check', cls: 'ok', t: 'Joost accepteerde <b>offerte 2026-019</b>', s: '€ 6.957,50 · huisstijl en fotoshoot', q: '“Akkoord, we hebben er zin in!”', time: '11:22' },
  ] },
];

// Vraagbalk: wat je kunt vinden of doen
const INDEX = [
  { g: 'Klanten', t: 'Bakkerij De Korenaar', sub: 'Joost Vermeer · K-1001', ic: 'users', go: 'klant', kw: 'korenaar bakkerij joost' },
  { g: 'Klanten', t: 'Restaurant Bloem', sub: 'Karim El Amrani · K-1005', ic: 'users', kw: 'bloem karim restaurant' },
  { g: 'Klanten', t: 'Van Dijk Installatietechniek', sub: 'Peter van Dijk · K-1003', ic: 'users', kw: 'van dijk peter installatie' },
  { g: 'Klanten', t: 'Fysio Centrum Zuid', sub: 'Maria Jansen · K-1002', ic: 'users', kw: 'fysio maria zuid' },
  { g: 'Klanten', t: 'Kinderopvang Zonnetje', sub: 'Els de Boer · prospect', ic: 'users', kw: 'zonnetje els kinderopvang' },
  { g: 'Projecten', t: 'Nieuwe huisstijl De Korenaar', sub: '35% · 14 van 40 uur', ic: 'folder-kanban', go: 'project', kw: 'huisstijl korenaar logo' },
  { g: 'Projecten', t: 'Menukaart & social Bloem', sub: 'Deadline vandaag', ic: 'folder-kanban', kw: 'menukaart bloem social' },
  { g: 'Projecten', t: 'Website Fysio Centrum Zuid', sub: '72% · oplevering 1 nov', ic: 'folder-kanban', kw: 'website fysio' },
  { g: 'Facturen', t: 'Factuur 2026-040', sub: 'Restaurant Bloem · € 786,50 · te laat', ic: 'receipt', go: 'facturen', peek: '2026-040', kw: 'factuur 2026-040 bloem te laat' },
  { g: 'Facturen', t: 'Factuur 2026-041', sub: 'Bakkerij De Korenaar · € 2.904,00', ic: 'receipt', go: 'facturen', peek: '2026-041', kw: 'factuur 2026-041 korenaar' },
  { g: 'Offertes', t: 'Offerte 2026-020', sub: 'Van Dijk · € 3.327,50 · verstuurd', ic: 'file-text', kw: 'offerte 2026-020 van dijk' },
  { g: 'Ga naar', t: 'Vandaag', ic: 'sunrise', go: 'vandaag', kw: 'vandaag dashboard home overzicht' },
  { g: 'Ga naar', t: 'Agenda · week 43', ic: 'calendar', go: 'agenda', kw: 'agenda week kalender' },
  { g: 'Ga naar', t: 'Gerrie · beslissingen', ic: 'sparkles', go: 'gerrie', kw: 'gerrie beslissingen voorstellen agents' },
  { g: 'Ga naar', t: 'Facturen', ic: 'receipt', go: 'facturen', kw: 'facturen geld' },
  { g: 'Maak', t: 'Nieuwe factuur', ic: 'receipt', fill: 'factuur ', key: 'F', kw: 'nieuwe factuur maken' },
  { g: 'Maak', t: 'Nieuwe taak', ic: 'list-todo', fill: 'taak ', key: 'T', kw: 'nieuwe taak maken' },
  { g: 'Maak', t: 'Nieuwe afspraak', ic: 'calendar-clock', fill: 'afspraak ', key: 'A', kw: 'nieuwe afspraak plannen' },
  { g: 'Maak', t: 'Uren boeken', ic: 'timer', fill: 'uren ', key: 'U', kw: 'uren boeken registreren' },
];
const ASK = [
  'Wat staat er nog open bij Restaurant Bloem?',
  'Plan mijn vrijdag rond de fotoshoot',
  'factuur bloem content oktober 650',
];
