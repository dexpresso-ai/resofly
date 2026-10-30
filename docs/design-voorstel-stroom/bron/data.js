/* ══ Voorbeeldgegevens ══════════════════════════════════════════════════════
   Uit de testomgeving (tests/mobile/mock/seed.mjs), zoals in het Zenit-voorstel:
   Studio Lopik en haar klanten, op donderdag 22 oktober 2026 om 09:41, week 43.
   Dezelfde dag en dezelfde cijfers, zodat je Zenit en Stroom naast elkaar
   kunt leggen. Zon op 08:15, zenit 13:25, onder 18:34 (Lopik). */
const DEMO = { now: 9 * 60 + 41, rise: 8 * 60 + 15, noon: 13 * 60 + 25, set: 18 * 60 + 34, week: 43, date: 'Donderdag 22 oktober', short: 'do 22 okt' };
const NEUTRAL = '#9C9A94';

const CLIENTS = {
  korenaar: { name: 'Bakkerij De Korenaar', short: 'De Korenaar', code: 'K-1001', contact: 'Joost Vermeer', role: 'eigenaar', email: 'joost@bakkerij.nl', phone: '06-1234 5610', city: 'Lopik', color: '#FFD966', ini: 'BK', status: 'Actief', tags: ['retail', 'huisstijl'], value: 18500, st: 'werk' },
  fysio: { name: 'Fysio Centrum Zuid', short: 'Fysio Zuid', code: 'K-1002', contact: 'Maria Jansen', role: 'praktijkhouder', email: 'maria@fysio.nl', phone: '06-1234 5611', city: 'Lopik', color: '#34D399', ini: 'FZ', status: 'Actief', tags: ['zorg'], value: 9200, st: 'betaald' },
  vandijk: { name: 'Van Dijk Installatietechniek', short: 'Van Dijk', code: 'K-1003', contact: 'Peter van Dijk', role: 'directeur', email: 'peter@van.nl', phone: '06-1234 5612', city: 'Lopik', color: '#60A5FA', ini: 'VD', status: 'Actief', tags: ['b2b', 'website'], value: 24000, st: 'offerte' },
  zonnetje: { name: 'Kinderopvang Zonnetje', short: 'Zonnetje', code: 'K-1004', contact: 'Els de Boer', role: 'locatiemanager', email: 'els@kinderopvang.nl', phone: '06-1234 5613', city: 'Lopik', color: '#F472B6', ini: 'KZ', status: 'Prospect', tags: ['zorg', 'huisstijl'], value: 4000, st: 'gesprek' },
  bloem: { name: 'Restaurant Bloem', short: 'Bloem', code: 'K-1005', contact: 'Karim El Amrani', role: 'eigenaar', email: 'karim@restaurant.nl', phone: '06-1234 5614', city: 'Lopik', color: '#FF9F43', ini: 'RB', status: 'Actief', tags: ['horeca', 'social'], value: 6600, st: 'factuur' },
  hendriks: { name: 'Notariskantoor Hendriks', short: 'Hendriks', code: 'K-1006', contact: 'Willem Hendriks', role: 'notaris', email: 'willem@notariskantoor.nl', phone: '06-1234 5615', city: 'Lopik', color: '#A78BFA', ini: 'NH', status: 'Inactief', tags: ['zakelijk'], value: 12000, st: null },
};

const PROJECTS = {
  huisstijl: { name: 'Nieuwe huisstijl De Korenaar', client: 'korenaar', color: '#FFD966' },
  fysioweb: { name: 'Website Fysio Centrum Zuid', client: 'fysio', color: '#34D399' },
  winter: { name: 'Campagne winteractie Van Dijk', client: 'vandijk', color: '#60A5FA' },
  menukaart: { name: 'Menukaart & social Bloem', client: 'bloem', color: '#FF9F43' },
  zonnetje: { name: 'Onboarding Zonnetje', client: 'zonnetje', color: '#F472B6' },
};

/* ── De stroom ───────────────────────────────────────────────────────────────
   Van eerste mail tot betaalde factuur, in vijf haltes. Elke kraal is één ding
   dat onderweg is; een knoop is iets dat vastzit (wacht = oranje, te laat =
   rood), met het voorstel van Gerrie dat hem losmaakt. */
const STATIONS = [
  { id: 'gesprek', label: 'Gesprek', sub: 'in gesprek', go: 'werk' },
  { id: 'offerte', label: 'Offerte', sub: 'bij de klant', go: 'geld:offertes' },
  { id: 'werk', label: 'Werk', sub: 'nog te factureren', go: 'werk' },
  { id: 'factuur', label: 'Factuur', sub: 'openstaand', go: 'geld:facturen' },
  { id: 'betaald', label: 'Betaald', sub: 'binnen in oktober', go: 'geld' },
];
const FLOW = [
  { id: 'f-zon', st: 'gesprek', c: 'zonnetje', t: 'Kinderopvang Zonnetje', s: 'Kennismaking vandaag 13:30 · offerte in de maak', amt: 4452.80, go: 'klant:zonnetje' },
  { id: 'f-flyer', st: 'gesprek', c: 'korenaar', t: 'Aanvraag: flyer herfstactie', s: 'Ticket van De Korenaar · nog geen bedrag', amt: 0, go: 'klant:korenaar' },
  { id: 'f-q020', st: 'offerte', c: 'vandijk', t: 'Offerte 2026-020', s: 'Van Dijk · 9 dagen bij de klant · 3× geopend', amt: 3327.50, knot: 'wait', dec: 'd3', go: 'geld:offertes' },
  { id: 'f-huis', st: 'werk', c: 'korenaar', t: 'Nieuwe huisstijl De Korenaar', s: '35% · 14 van 40 uur', amt: 4053.50, go: 'klant:korenaar' },
  { id: 'f-menu', st: 'werk', c: 'bloem', t: 'Menukaart & social Bloem', s: 'Content oktober · deadline vandaag', amt: 786.50, go: 'klant:bloem' },
  { id: 'f-web', st: 'werk', c: 'fysio', t: 'Website Fysio Centrum Zuid', s: '72% · oplevering 1 november', amt: 0, go: 'klant:fysio' },
  { id: 'f-i041', st: 'factuur', c: 'korenaar', t: 'Factuur 2026-041', s: 'De Korenaar · vervalt 28 okt · 2× geopend', amt: 2904, go: 'factuur:2026-041' },
  { id: 'f-i040', st: 'factuur', c: 'bloem', t: 'Factuur 2026-040', s: 'Restaurant Bloem · 10 dagen te laat', amt: 786.50, knot: 'late', dec: 'd1', go: 'factuur:2026-040' },
  { id: 'f-i039', st: 'betaald', c: 'fysio', t: 'Factuur 2026-039', s: 'Fysio Centrum Zuid · betaald 21 okt', amt: 6292, go: 'factuur:2026-039' },
];

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
const LEFTOVER = { t: 'Terugbellen Peter over planning', p: 'winter', note: 'gisteren blijven liggen' };

// Te beslissen — wat Gerrie en de agents klaarzetten
const DECISIONS = [
  { id: 'd1', icon: 'bell-ring', agent: 'Debiteurenbewaker', at: '08:30', flow: 'f-i040', title: 'Herinnering voor factuur 2026-040', why: 'Restaurant Bloem · € 786,50 · 10 dagen te laat. Karim betaalde de vorige twee binnen 2 dagen na een herinnering.', cta: 'Verstuur herinnering', undo: 'Herinnering aan Karim', doneText: 'Herinnering verstuurd naar Karim El Amrani' },
  { id: 'd2', icon: 'clock', agent: 'Gerrie', at: '08:00', title: '3u 15m uren uit je agenda van gisteren', why: 'Werksessie wireframes (2u · Website Fysio) en belafspraak Peter (1u 15m · Van Dijk).', cta: 'Boek de uren', undo: '3u 15m op twee projecten', doneText: '3u 15m geboekt op twee projecten' },
  { id: 'd3', icon: 'mail', agent: 'Gerrie', at: '07:55', flow: 'f-q020', title: 'Offerte 2026-020 wacht al 9 dagen', why: 'Peter van Dijk opende hem 3× — laatst gisteren om 21:14. Er staat een korte opvolgmail klaar.', cta: 'Verstuur opvolgmail', undo: 'Opvolgmail aan Peter', doneText: 'Opvolgmail verstuurd naar Peter van Dijk' },
  { id: 'd4', icon: 'receipt', agent: 'Inkoop-inbox', at: '07:12', title: '2 inkoopfacturen herkend in je mail', why: 'Adobe (€ 71,39) en Drukkerij Lopik (€ 412,50). Het boekingsvoorstel staat klaar.', cta: 'Boek ze in', undo: '2 inkoopfacturen', doneText: '2 inkoopfacturen geboekt' },
];

const DDETAIL = {
  d1: {
    sub: 'Debiteurenbewaker · draait elke werkdag om 08:30 · namens jou',
    facts: [['Vervallen op', '12 okt · 10 dagen'], ['Bedrag', '€ 786,50'], ['Vorige keren', '2× binnen 2 dagen']],
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
  { n: '2026-042', c: 'zonnetje', d: 'Onboarding', date: '—', due: '—', amt: 423.50, ex: 350, st: 'concept', note: 'Nog niet verstuurd' },
  { n: '2026-041', c: 'korenaar', d: 'Huisstijl fase 1', date: '10 okt', due: '28 okt', amt: 2904.00, ex: 2400, st: 'open', note: 'Geopend 2×', sent: '10 okt 09:05' },
  { n: '2026-040', c: 'bloem', d: 'Content september', date: '12 sep', due: '12 okt', amt: 786.50, ex: 650, st: 'late', note: '10 dagen te laat', sent: '12 sep 10:14' },
  { n: '2026-039', c: 'fysio', d: 'Website oplevering', date: '2 okt', due: '16 okt', amt: 6292.00, ex: 5200, st: 'paid', note: 'Betaald 21 okt', sent: '2 okt 11:30' },
  { n: '2026-038', c: 'vandijk', d: 'Advies (6 uur)', date: '2 sep', due: '16 sep', amt: 617.10, ex: 510, st: 'paid', note: 'Betaald 15 sep', sent: '2 sep 16:02' },
  { n: '2026-037', c: 'bloem', d: 'Content augustus', date: '13 aug', due: '27 aug', amt: 786.50, ex: 650, st: 'paid', note: 'Betaald 26 aug', sent: '13 aug 09:40' },
];
const INV_ST = { concept: ['Concept', ''], open: ['Openstaand', 'info'], late: ['Te laat', 'danger'], paid: ['Betaald', 'ok'] };
const QUOTES = [
  { n: '2026-021', c: 'zonnetje', d: 'Huisstijlpakket en drukwerk', date: '—', amt: 4452.80, st: 'concept', note: 'In de maak' },
  { n: '2026-020', c: 'vandijk', d: 'Campagne winteractie', date: '13 okt', amt: 3327.50, st: 'sent', note: '3× geopend' },
  { n: '2026-019', c: 'korenaar', d: 'Huisstijl en fotoshoot', date: '2 okt', amt: 6957.50, st: 'accepted', note: 'Geaccepteerd 9 okt' },
  { n: '2026-018', c: 'fysio', d: 'Onderhoud per maand', date: '12 sep', amt: 1379.40, st: 'rejected', note: 'Afgewezen 20 sep' },
];
const Q_ST = { concept: ['Concept', ''], sent: ['Bij de klant', 'warn'], accepted: ['Geaccepteerd', 'ok'], rejected: ['Afgewezen', ''] };

// Geldstroom: saldo (ABN AMRO zakelijk) — 30 dagen terug en 30 dagen vooruit
const CASH = {
  now: 14380.22,
  past: [[-30, 10730.22], [-22, 10730.22], [-21, 9480.22], [-17, 9480.22], [-16, 9068.22], [-8, 9068.22], [-7, 8088.22], [-2, 8088.22], [-1, 14380.22], [0, 14380.22]],
  future: [[0, 14380.22], [2, 15166.72, '+ € 786,50', 'Bloem'], [6, 18070.72, '+ € 2.904', 'Korenaar'], [10, 16820.72, '− € 1.250', 'Huur'], [12, 16336.83], [19, 13936.83, '− € 2.400', 'Loon'], [29, 17990.33, '+ € 4.053', 'Fase 2'], [30, 17990.33]],
};

/* ── Klant 360 ──────────────────────────────────────────────────────────── */
const C360 = {
  korenaar: {
    line: [
      { st: 'gesprek', t: 'Kick-off en briefing', s: '2 oktober', done: true },
      { st: 'offerte', t: 'Offerte 2026-019', s: '€ 6.957,50 · akkoord 9 okt', done: true },
      { st: 'werk', t: 'Huisstijl · 35%', s: '14 van 40 uur', now: true },
      { st: 'factuur', t: 'Factuur 2026-041', s: '€ 2.904 · vervalt 28 okt', now: true },
      { st: 'betaald', t: 'Nog € 4.053,50', s: 'na fase 2 te factureren' },
    ],
    gerrie: 'Joost reageert meestal <b>binnen 4 uur</b> en belt liever dan dat hij mailt. Hij koos dinsdag voor <b>richting C</b>; Sanne meldt dat hij de definitieve logobestanden <b>vóór de lunch</b> wil zien. Volgende mijlpaal: <b>drukproef briefpapier</b>, morgen.',
    acts: [['Agenda voor 10:00 maken', 'sparkles', 'ai'], ['Bestanden sturen', 'send', '']],
    stats: [['Relatiewaarde', '€ 18.500'], ['Openstaand', '€ 2.904<small>,00</small>'], ['Lopend werk', '1 project · 35%'], ['Relatiepuls', 'Warm']],
    pulse: [3, 5, 4, 6, 8, 7, 9, 11],
    project: { name: 'Nieuwe huisstijl De Korenaar', pct: 35, hours: '14 van 40 uur', due: 'Oplevering 13 november', team: ['gl', 'sb'] },
    money: [['Offerte 2026-019', '€ 6.957<small>,50</small>', 'ok', 'akkoord'], ['Gefactureerd', '€ 2.904<small>,00</small>', '', '42%'], ['Nog te factureren', '€ 4.053<small>,50</small>', '', '']],
  },
  bloem: {
    line: [
      { st: 'gesprek', t: 'Maandcontract social', s: 'sinds maart', done: true },
      { st: 'offerte', t: 'Content per maand', s: '€ 786,50 · akkoord', done: true },
      { st: 'werk', t: 'Menukaart & social', s: 'deadline vandaag', now: true },
      { st: 'factuur', t: 'Factuur 2026-040', s: '€ 786,50 · 10 dagen te laat', now: true, knot: 'late' },
      { st: 'betaald', t: 'Factuur 2026-037', s: '€ 786,50 · 26 aug' , done: true },
    ],
    gerrie: 'Karim betaalt bijna altijd <b>binnen 2 dagen na een herinnering</b>; de factuur van september is er waarschijnlijk tussendoor geschoten. De fotoshoot van vrijdag staat bevestigd. Daan zet de posts voor week 44 klaar.',
    acts: [['Herinnering bekijken', 'bell-ring', 'ai'], ['Menukaart openen', 'file-text', '']],
    stats: [['Relatiewaarde', '€ 6.600'], ['Openstaand', '€ 786<small>,50</small>'], ['Lopend werk', '1 project · doorlopend'], ['Relatiepuls', 'Warm']],
    pulse: [6, 6, 7, 5, 8, 6, 7, 9],
    project: { name: 'Menukaart & social Bloem', pct: 80, hours: 'deze maand 9 van 11 uur', due: 'Menukaart vandaag drukklaar', team: ['gl', 'db'] },
    money: [['Per maand', '€ 786<small>,50</small>', '', 'content'], ['Te laat', '€ 786<small>,50</small>', 'danger', '2026-040'], ['Dit jaar betaald', '€ 5.505<small>,50</small>', 'ok', '7 facturen']],
  },
};

const TIMELINE = {
  korenaar: [
    { day: 'Vandaag', items: [
      { ic: 'video', cls: 'gold', t: '<b>Overleg Joost — kleurenpalet</b>', s: '10:00 – 11:00 · Video via Jitsi · jij en Sanne', time: '10:00', k: 'agenda' },
    ] },
    { day: 'Gisteren', items: [
      { ic: 'message-square', t: '<b>Sanne</b> deelde drie logovarianten in de teamchat', s: 'A: het bestaande, iets strakker · B: zonder aar · C: aar als accent op de K', time: '09:31', k: 'mail' },
      { ic: 'mail-open', t: 'Joost opende <b>factuur 2026-041</b> voor de tweede keer', s: '€ 2.904,00 · vervalt 28 oktober', time: '16:40', k: 'geld' },
    ] },
    { day: 'Dinsdag 20 oktober', items: [
      { ic: 'monitor', t: '<b>Presentatie concept</b> in de studio', s: 'Joost, Sanne en jij · 1 uur', q: '“Richting C voelt het meest als ons. Kunnen we de aar nog iets kleiner?”', time: '14:00', k: 'agenda' },
    ] },
    { day: 'Zaterdag 10 oktober', items: [
      { ic: 'send', t: '<b>Factuur 2026-041</b> verstuurd', s: 'Huisstijl fase 1 · € 2.904,00', time: '09:05', k: 'geld' },
    ] },
    { day: 'Vrijdag 9 oktober', items: [
      { ic: 'circle-check', cls: 'ok', t: 'Joost accepteerde <b>offerte 2026-019</b>', s: '€ 6.957,50 · huisstijl en fotoshoot', q: '“Akkoord, we hebben er zin in!”', time: '11:22', k: 'geld' },
    ] },
  ],
  bloem: [
    { day: 'Vandaag', items: [
      { ic: 'bell-ring', cls: 'ai', t: 'Gerrie zette een <b>herinnering</b> klaar voor factuur 2026-040', s: 'Debiteurenbewaker · 08:30', time: '08:30', k: 'geld' },
    ] },
    { day: 'Gisteren', items: [
      { ic: 'message-square', t: '<b>Daan</b>: “De fotoshoot van vrijdag staat rond, Karim heeft bevestigd.”', s: 'Teamchat · Studio algemeen', time: '09:12', k: 'mail' },
    ] },
    { day: 'Maandag 12 oktober', items: [
      { ic: 'triangle-alert', cls: 'danger', t: '<b>Factuur 2026-040</b> vervallen', s: 'Content september · € 786,50', time: '00:00', k: 'geld' },
    ] },
    { day: 'Woensdag 26 augustus', items: [
      { ic: 'circle-check', cls: 'ok', t: 'Karim betaalde <b>factuur 2026-037</b>', s: '€ 786,50 · twee dagen na de herinnering', time: '14:02', k: 'geld' },
    ] },
  ],
};

/* ── Agenda: week 43, ma 19 – vr 23 oktober (d = 0..4) ──────────────────── */
const WEEK = [
  { d: 0, s: 540, e: 570, t: 'Weekstart team', w: 'Studio', c: NEUTRAL },
  { d: 0, s: 600, e: 720, t: 'Wireframes afsprakenmodule', w: 'Focus', c: '#34D399', focus: true },
  { d: 0, s: 810, e: 870, t: 'Kick-off nieuwsbrief november', w: 'Studio', c: '#A78BFA' },
  { d: 1, s: 600, e: 720, t: 'Instagram-reels schetsen', w: 'Focus', c: '#FF9F43', focus: true },
  { d: 1, s: 840, e: 900, t: 'Presentatie concept De Korenaar', w: 'Studio', c: '#FFD966' },
  { d: 2, s: 600, e: 690, t: 'Mailing winteractie schrijven', w: 'Focus', c: '#60A5FA', focus: true },
  { d: 2, s: 780, e: 900, t: 'Werksessie wireframes', w: 'Studio', c: '#34D399' },
  { d: 2, s: 930, e: 1005, t: 'Belafspraak Peter van Dijk', w: 'Telefoon', c: '#60A5FA' },
  { d: 4, s: 540, e: 720, t: 'Fotoshoot Bloem', w: 'Restaurant Bloem', c: '#FF9F43' },
  { d: 4, s: 900, e: 960, t: 'Weekafsluiting', w: 'Studio', c: NEUTRAL },
];
// Nog in te plannen; Gerrie zoekt er ruimte voor
const TRAY = [
  { id: 'p1', t: 'Drukproef briefpapier', p: 'huisstijl', est: 45, due: 'deadline vr 23 okt', plan: { d: 4, s: 960 } },
  { id: 'p2', t: 'Instagram-reels monteren', p: 'menukaart', est: 120, due: 'deadline di 27 okt', plan: { d: 4, s: 780 } },
  { id: 'p3', t: 'Teksten homepage', p: 'fysioweb', est: 90, due: 'deadline do 29 okt', plan: { next: 'ma 26 okt 09:30' } },
];

/* ── Gerrie: wat hij antwoordt in het eiland ────────────────────────────── */
const ANSWERS = [
  { re: /bloem|karim/i, a: 'Bij <b>Restaurant Bloem</b> staat <b>€ 786,50</b> open: factuur 2026-040 voor de content van september, nu 10 dagen te laat. Karim betaalde de vorige twee binnen 2 dagen na een herinnering; die staat al voor je klaar. De menukaart moet vandaag drukklaar.', acts: [['Herinnering bekijken', 'bell-ring', 'dec:d1', 'ai'], ['Open Restaurant Bloem', 'arrow-up-right', 'klant:bloem', '']] },
  { re: /vrijdag|plan|week/i, a: 'Vrijdag staat de <b>fotoshoot bij Bloem</b> van 09:00 tot 12:00, en om 15:00 de weekafsluiting. Daartussen is 2 uur vrij: daar past <b>Instagram-reels monteren</b>. De <b>drukproef briefpapier</b> (45 min) kan om 16:00, vóór de deadline. <b>Teksten homepage</b> past deze week niet meer; die zet ik op maandag.', acts: [['Plan het zo in', 'calendar-plus', 'plan', 'ai'], ['Open de week', 'calendar', 'agenda', '']] },
  { re: /geld|omzet|binnen|saldo|cash|betaald/i, a: 'In oktober is <b>€ 6.292</b> binnengekomen en staat <b>€ 3.690,50</b> nog open, waarvan € 786,50 te laat. Je saldo is <b>€ 14.380</b>; met wat er de komende 30 dagen in- en uitgaat kom je naar verwachting op <b>€ 17.990</b>.', acts: [['Open de geldstroom', 'waves', 'geld', ''], ['Herinnering bekijken', 'bell-ring', 'dec:d1', 'ai']] },
  { re: /korenaar|joost/i, a: 'De huisstijl voor <b>De Korenaar</b> staat op 35% (14 van 40 uur). Om 10:00 heb je overleg met Joost over het kleurenpalet. Factuur 2026-041 (€ 2.904) is twee keer geopend en vervalt 28 oktober.', acts: [['Open De Korenaar', 'arrow-up-right', 'klant:korenaar', '']] },
];
const ASK = [
  'Wat staat er nog open bij Restaurant Bloem?',
  'Plan mijn vrijdag rond de fotoshoot',
  'factuur bloem content oktober 650',
];

// Het eiland: wat je kunt vinden of doen
const INDEX = [
  { g: 'Klanten', t: 'Bakkerij De Korenaar', sub: 'Joost Vermeer · K-1001', ic: 'users', go: 'klant:korenaar', kw: 'korenaar bakkerij joost', c: 'korenaar' },
  { g: 'Klanten', t: 'Restaurant Bloem', sub: 'Karim El Amrani · K-1005', ic: 'users', go: 'klant:bloem', kw: 'bloem karim restaurant', c: 'bloem' },
  { g: 'Klanten', t: 'Van Dijk Installatietechniek', sub: 'Peter van Dijk · K-1003', ic: 'users', go: 'klant:vandijk', kw: 'van dijk peter installatie', c: 'vandijk' },
  { g: 'Klanten', t: 'Fysio Centrum Zuid', sub: 'Maria Jansen · K-1002', ic: 'users', go: 'klant:fysio', kw: 'fysio maria zuid', c: 'fysio' },
  { g: 'Klanten', t: 'Kinderopvang Zonnetje', sub: 'Els de Boer · prospect', ic: 'users', go: 'klant:zonnetje', kw: 'zonnetje els kinderopvang', c: 'zonnetje' },
  { g: 'Facturen', t: 'Factuur 2026-040', sub: 'Restaurant Bloem · € 786,50 · te laat', ic: 'receipt', go: 'factuur:2026-040', kw: 'factuur 2026-040 bloem te laat' },
  { g: 'Facturen', t: 'Factuur 2026-041', sub: 'Bakkerij De Korenaar · € 2.904,00', ic: 'receipt', go: 'factuur:2026-041', kw: 'factuur 2026-041 korenaar' },
  { g: 'Offertes', t: 'Offerte 2026-020', sub: 'Van Dijk · € 3.327,50 · bij de klant', ic: 'file-text', go: 'geld:offertes', kw: 'offerte 2026-020 van dijk' },
  { g: 'Ga naar', t: 'Vandaag', ic: 'sunrise', go: 'vandaag', kw: 'vandaag dashboard home overzicht', key: 'G V' },
  { g: 'Ga naar', t: 'Gerrie · te beslissen', ic: 'sparkles', go: 'gerrie', kw: 'gerrie beslissingen voorstellen agents', key: 'G G' },
  { g: 'Ga naar', t: 'Agenda · week 43', ic: 'calendar', go: 'agenda', kw: 'agenda week kalender planning', key: 'G A' },
  { g: 'Ga naar', t: 'Geld · facturen', ic: 'wallet', go: 'geld', kw: 'geld facturen geldstroom bank', key: 'G F' },
  { g: 'Ga naar', t: 'Werk · klanten', ic: 'folder-kanban', go: 'werk', kw: 'werk klanten projecten', key: 'G W' },
  { g: 'Maak', t: 'Nieuwe factuur', ic: 'receipt', fill: 'factuur ', kw: 'nieuwe factuur maken' },
  { g: 'Maak', t: 'Nieuwe offerte', ic: 'file-text', fill: 'offerte ', kw: 'nieuwe offerte maken' },
  { g: 'Maak', t: 'Nieuwe taak', ic: 'list-todo', fill: 'taak ', kw: 'nieuwe taak maken' },
  { g: 'Maak', t: 'Nieuwe afspraak', ic: 'calendar-clock', fill: 'afspraak ', kw: 'nieuwe afspraak plannen' },
  { g: 'Maak', t: 'Uren boeken', ic: 'timer', fill: 'uren ', kw: 'uren boeken registreren' },
];
const RECENT = [
  { t: 'Bakkerij De Korenaar', sub: 'Klant · gisteren', ic: 'users', go: 'klant:korenaar', c: 'korenaar' },
  { t: 'Factuur 2026-041', sub: 'Factuur · gisteren', ic: 'receipt', go: 'factuur:2026-041' },
  { t: 'Week 43', sub: 'Agenda · maandag', ic: 'calendar', go: 'agenda' },
];
const CLIENT_WORDS = [
  ['korenaar', /korenaar|bakkerij|joost/i], ['bloem', /bloem|karim|restaurant/i], ['vandijk', /van ?dijk|peter|installatie/i],
  ['fysio', /fysio|maria/i], ['zonnetje', /zonnetje|els|kinderopvang/i], ['hendriks', /hendriks|notaris|willem/i],
];

/* ── Hulpjes ────────────────────────────────────────────────────────────── */
const NL = new Intl.NumberFormat('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const NL0 = new Intl.NumberFormat('nl-NL', { maximumFractionDigits: 0 });
// € 3.690,50 met de centen klein; whole=true laat de centen weg
const eur = (n, whole = false) => {
  const neg = n < 0; const v = Math.abs(n);
  if (whole) return `${neg ? '− ' : ''}€ ${NL0.format(Math.round(v))}`;
  const [a, b] = NL.format(v).split(',');
  return `${neg ? '− ' : ''}€ ${a}<small>,${b}</small>`;
};
const eurTxt = n => `€ ${NL.format(n)}`;
const hhmm = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(Math.round(m % 60)).padStart(2, '0')}`;
const dur = m => m >= 60 ? `${Math.floor(m / 60)}u${m % 60 ? ' ' + (m % 60) + 'm' : ''}` : `${m}m`;
const esc = s => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const ic = (n, c = '') => `<svg class="i ${c}" aria-hidden="true"><use href="#i-${n}"></use></svg>`;
const colorOf = it => it.c && it.c.startsWith && it.c.startsWith('#') ? it.c : (it.p ? PROJECTS[it.p].color : (it.c && CLIENTS[it.c] ? CLIENTS[it.c].color : NEUTRAL));
const stationTotals = () => STATIONS.map(s => FLOW.filter(f => f.st === s.id).reduce((a, f) => a + f.amt, 0));
