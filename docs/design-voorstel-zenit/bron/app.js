/* ══ Prototype ══════════════════════════════════════════════════════════════ */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const ic = (n, c = '') => `<svg class="i ${c}" aria-hidden="true"><use href="#i-${n}"></use></svg>`;
const pad = n => String(n).padStart(2, '0');
const hm = m => { m = Math.round(m); m = ((m % 1440) + 1440) % 1440; return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`; };
const grp = i => i.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const eur = (v, cents = true) => { const [i, d] = Math.abs(v).toFixed(2).split('.'); return `<span class="amt">${v < 0 ? '− ' : ''}€ ${grp(i)}${cents ? `<small>,${d}</small>` : ''}</span>`; };
const eurTxt = (v, cents = true) => { const [i, d] = Math.abs(v).toFixed(2).split('.'); return `${v < 0 ? '− ' : ''}€ ${grp(i)}${cents ? ',' + d : ''}`; };
const dur = m => m >= 60 ? `${Math.floor(m / 60)}u${m % 60 ? ' ' + (m % 60) + 'm' : ''}` : `${m}m`;
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const MONTHS = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
const WEEKDAYS = ['zondag', 'maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag'];
const evColor = ev => ev.c || (ev.p ? PROJECTS[ev.p].color : NEUTRAL);
let appScale = 1;

/* De zon boven Lopik op 22 oktober (NOAA-benadering, wandklok CEST). */
function sunTimes() {
  const doy = Math.round((Date.UTC(DEMO.y, DEMO.m, DEMO.d) - Date.UTC(DEMO.y, 0, 1)) / 864e5) + 1;
  const g = 2 * Math.PI / 365 * (doy - 1);
  const eq = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const r = Math.PI / 180, lat = DEMO.lat * r;
  const ha = Math.acos(Math.cos(90.833 * r) / (Math.cos(lat) * Math.cos(decl)) - Math.tan(lat) * Math.tan(decl)) / r;
  const off = DEMO.tz * 60;
  return { rise: 720 - 4 * (DEMO.lon + ha) - eq + off, set: 720 - 4 * (DEMO.lon - ha) - eq + off, noon: 720 - 4 * DEMO.lon - eq + off };
}
const SUN = sunTimes();
const isDay = t => t >= SUN.rise && t < SUN.set;
const greet = t => t < 360 ? 'Goedenacht' : t < 720 ? 'Goedemorgen' : t < 1080 ? 'Goedemiddag' : 'Goedenavond';

/* ── Toestand ── */
const S = {
  screen: 'vandaag', time: DEMO.now, playing: false,
  decisions: DECISIONS.map(d => d.id), gsel: 'd1',
  tasks: TASKS.map(t => ({ ...t })),
  board: JSON.parse(JSON.stringify(BOARD)), ghost: true, aiSlot: true,
  inv: { f: 'alle', q: '', sel: new Set() }, peek: null,
  tabs: [{ id: 1, screen: 'vandaag' }, { id: 2, screen: 'klant' }, { id: 3, screen: 'facturen' }], tab: 1, seq: 3,
  notes: false, note: 0, ck: { open: false, idx: 0 }, ktab: 'overzicht', density: 'ruim',
};

const SCREENS = {
  vandaag: { mod: 'vandaag', label: 'Vandaag', ic: 'sunrise' },
  gerrie: { mod: 'gerrie', label: 'Beslissingen', ic: 'sparkles' },
  agenda: { mod: 'agenda', label: 'Week 43', ic: 'calendar' },
  klant: { mod: 'werk', label: 'Bakkerij De Korenaar', ic: 'users' },
  project: { mod: 'werk', label: 'Nieuwe huisstijl', ic: 'folder-kanban' },
  facturen: { mod: 'geld', label: 'Facturen', ic: 'receipt' },
  berichten: { mod: 'berichten', label: 'Berichten', ic: 'inbox' },
  inzicht: { mod: 'inzicht', label: 'Inzicht', ic: 'bar-chart-3' },
};
const MODS = [['vandaag', 'sunrise', 'Vandaag', 'G V'], ['gerrie', 'sparkles', 'Gerrie', 'G G'], ['agenda', 'calendar', 'Agenda', 'G A'], ['werk', 'folder-kanban', 'Werk', 'G W'], ['geld', 'wallet', 'Geld', 'G F'], ['berichten', 'inbox', 'Berichten', 'G B'], ['inzicht', 'bar-chart-3', 'Inzicht', 'G I']];
const MOD_HOME = { vandaag: 'vandaag', gerrie: 'gerrie', agenda: 'agenda', werk: 'klant', geld: 'facturen', berichten: 'berichten', inzicht: 'inzicht' };
const PANELS = {
  vandaag: { t: 'Vandaag', nav: [['vandaag', 'layout-dashboard', 'Overzicht'], ['agenda', 'calendar-range', 'Mijn week', '28u'], ['gerrie', 'sparkles', 'Te beslissen', 'dec'], [null, 'bell', 'Meldingen', '3']],
    secs: [['Vastgezet', [['project', '#FFD966', 'Nieuwe huisstijl De Korenaar'], [null, '#34D399', 'Website Fysio Centrum Zuid'], ['klant', '#FF9F43', 'Restaurant Bloem']]], ['Weergaven', [[null, 'list-checks', 'Mijn open taken', '12'], [null, 'triangle-alert', 'Te laat', '2'], [null, 'calendar-days', 'Deze week', '9']]]] },
  gerrie: { t: 'Gerrie', nav: [['gerrie', 'check-check', 'Beslissingen', 'dec'], [null, 'message-square', 'Gesprekken'], [null, 'bot', 'Agents', '4'], [null, 'repeat', 'Routines'], [null, 'history', 'Logboek']],
    secs: [['Agents van jou', [[null, '#F7C548', 'Debiteurenbewaker'], [null, '#F7C548', 'Ochtendbriefing'], [null, '#F7C548', 'Inkoop-inbox'], [null, '#9C9A94', 'Urencheck op vrijdag']]]] },
  agenda: { t: 'Agenda', nav: [['agenda', 'calendar', 'Week'], [null, 'calendar-range', 'Weekplanner'], [null, 'calendar-clock', 'Boekingslinks', '2'], [null, 'timer', 'Uren', '26,5u']],
    secs: [["Agenda's", [[null, '#F7C548', 'Studio-agenda'], [null, '#FFD966', 'Gerjan'], [null, '#34D399', 'Sanne'], [null, '#60A5FA', 'Daan']]]] },
  werk: { t: 'Werk', nav: [['klant', 'users', 'Klanten', '6'], ['project', 'folder-kanban', 'Projecten', '5'], [null, 'list-checks', 'Taken', '18'], [null, 'ticket', 'Tickets', '2'], [null, 'archive', 'Archief']],
    secs: [['Vastgezet', [['klant', '#FFD966', 'Bakkerij De Korenaar'], ['project', '#FFD966', 'Nieuwe huisstijl De Korenaar'], [null, '#FF9F43', 'Menukaart & social Bloem']]]] },
  geld: { t: 'Geld', groups: [['Verkoop', [[null, 'file-text', 'Offertes', '2'], [null, 'file-pen-line', 'Contracten'], ['facturen', 'receipt', 'Facturen', '!1']]], ['Inkoop', [[null, 'truck', 'Leveranciers'], [null, 'inbox', 'Inkoopfacturen', '2']]], ['Boekhouding', [[null, 'landmark', 'Bank'], [null, 'book-open', 'Grootboek'], [null, 'boxes', 'Activa']]], ['Rapportage', [[null, 'trending-up', 'Winst & verlies'], [null, 'percent', 'Omzetbelasting'], [null, 'scale', 'Jaarrekening']]]] },
  berichten: { t: 'Berichten', nav: [['berichten', 'inbox', 'Postvak', '3'], [null, 'message-square', 'Chat', '2'], [null, 'megaphone', 'Marketing']], secs: [] },
  inzicht: { t: 'Inzicht', nav: [['inzicht', 'bar-chart-3', 'Statistieken'], [null, 'library', 'Inhoud']], secs: [] },
};

/* ── Schil ── */
function shell() {
  const mods = MODS.map(([k, i, l, key], n) => `${n === 2 || n === 5 ? '<span class="rail-sep" aria-hidden="true"></span>' : ''}<button class="rail-btn${k === 'gerrie' ? ' ai' : ''}" data-mod="${k}" aria-label="${l}">${ic(i)}${k === 'gerrie' ? '<span class="count" data-count="dec"></span>' : ''}<span class="tip">${l}<kbd>${key}</kbd></span></button>`).join('');
  return `<nav class="rail tn" aria-label="Modules">
    <button class="rail-logo" data-go="vandaag" aria-label="ResoFly, naar Vandaag">R</button>${mods}
    <div class="rail-foot">
      <button class="rail-btn" data-act="weergave" aria-label="Weergave" aria-haspopup="dialog">${ic('sun-moon')}<span class="tip">Weergave</span></button>
      <button class="rail-btn" data-act="nyi" data-what="Instellingen" aria-label="Instellingen">${ic('settings')}<span class="tip">Instellingen</span></button>
      <button class="av rail-me" data-act="nyi" data-what="Je account" aria-label="Gerjan van Lopik, account">GL</button>
    </div>
  </nav>
  <aside class="panel" id="panel" aria-label="Contextpaneel"></aside>
  <header class="tabs" id="tabs" role="tablist" aria-label="Werktabs"></header>
  <main class="canvas" id="canvas">
    <div class="view" id="view"></div>
    <aside class="peek" id="peek" aria-label="Spiekpaneel"></aside>
    <div class="bulk" id="bulk" aria-live="polite"></div>
    <div class="toasts" id="toasts" aria-live="polite"></div>
  </main>
  <div class="cmdk" id="cmdk" hidden></div>
  <div class="pop" id="pop" role="dialog" aria-label="Weergave" hidden></div>`;
}

function renderRail() {
  const mod = SCREENS[S.screen].mod;
  $$('.rail-btn[data-mod]').forEach(b => { const on = b.dataset.mod === mod; b.classList.toggle('is-on', on); b.setAttribute('aria-current', on ? 'page' : 'false'); });
}
function renderTabs() {
  $('#tabs').innerHTML = S.tabs.map(t => { const m = SCREENS[t.screen]; const on = t.id === S.tab; return `<div class="tab${on ? ' is-on' : ''}" role="tab" aria-selected="${on}" tabindex="${on ? 0 : -1}" data-tab="${t.id}">${ic(m.ic, 'i-sm')}<span>${m.label}</span>${S.tabs.length > 1 ? `<button class="x" data-close="${t.id}" aria-label="Sluit ${m.label}">${ic('x', 'i-xs')}</button>` : ''}</div>`; }).join('')
    + `<button class="btn-icon tab-new" data-act="newtab" aria-label="Nieuw tabblad">${ic('plus', 'i-sm')}</button>
    <button class="ask" data-act="cmdk" data-note-k="ask"><span class="orb live"></span><span class="lbl">Vraag Gerrie, zoek of maak iets…</span><kbd>⌘K</kbd></button>
    <button class="btn-icon" data-act="nyi" data-what="Meldingen" aria-label="Meldingen, 3 nieuw">${ic('bell')}<span class="bell-dot"></span></button>`;
}
function renderPanel() {
  const P = PANELS[SCREENS[S.screen].mod];
  const cnt = n => n === 'dec' ? `<span class="n" data-count="dec-n">${S.decisions.length || ''}</span>` : n ? `<span class="n${n[0] === '!' ? ' alert' : ''}">${n[0] === '!' ? n.slice(1) + ' te laat' : n}</span>` : '';
  const item = ([go, i, l, n], nav) => `<button class="pnav-item${nav && go === S.screen ? ' is-on' : ''}" ${go ? `data-go="${go}"` : `data-act="nyi" data-what="${l}"`}>${i[0] === '#' ? `<span class="dot" style="--c:${i}"></span>` : ic(i)}<span class="l">${l}</span>${cnt(n)}</button>`;
  const body = P.groups
    ? P.groups.map(([h, items]) => `<div class="pnav-h">${h}</div><div class="pnav">${items.map(x => item(x, true)).join('')}</div>`).join('')
    : `<div class="pnav">${P.nav.map(x => item(x, true)).join('')}</div>` + P.secs.map(([h, items]) => `<div class="pnav-h">${h}</div><div class="pnav">${items.map(x => item(x, false)).join('')}</div>`).join('');
  $('#panel').innerHTML = `<button class="org" data-act="nyi" data-what="Wisselen van organisatie"><span class="org-tile">SL</span><span class="org-n"><b>Studio Lopik</b><span>3 teamleden · owner</span></span>${ic('chevron-down', 'i-sm')}</button>
    <div class="mod-h"><h2>${P.t}</h2><button class="btn-icon" data-act="cmdk-new" aria-label="Nieuw in ${P.t}" style="--h:28px">${ic('plus', 'i-sm')}</button></div>
    <div class="panel-scroll">${body}</div>
    <div class="panel-foot"><span class="orb sm live"></span><b>Gerrie waakt</b><span class="t">3 agents actief · volgende ronde 13:00</span></div>`;
}
function updateCounts() {
  const n = S.decisions.length;
  $$('[data-count="dec"]').forEach(el => { el.textContent = n; el.hidden = !n; });
  $$('[data-count="dec-n"]').forEach(el => { el.textContent = n || ''; });
  $$('[data-count="dec-txt"]').forEach(el => { el.textContent = n === 1 ? '1 voorstel' : `${n} voorstellen`; });
}

/* ── Navigeren ── */
function go(screen, opts = {}) {
  if (!SCREENS[screen]) return;
  closePeek(true);
  const tab = S.tabs.find(t => t.screen === screen);
  if (tab && !opts.here) S.tab = tab.id; else S.tabs.find(t => t.id === S.tab).screen = screen;
  S.screen = screen;
  renderTabs(); renderPanel(); renderRail(); renderView();
  onScreen(screen);
}
let onScreen = () => {};
function renderView(enter = true) {
  const v = $('#view');
  v.innerHTML = `<div class="pg${enter && !reduced() ? ' enter' : ''}">${VIEWS[S.screen]()}</div>`;
  v.scrollTop = 0;
  (MOUNT[S.screen] || (() => {}))();
  updateCounts();
  if (S.notes) requestAnimationFrame(placeNotes);
}

/* ══ Vandaag ══ */
const ARC = { t0: 420, t1: 1260, hz: 150, A: 128, below: .3, top: 38, k: .6 };
const ax = t => (t - ARC.t0) / (ARC.t1 - ARC.t0) * 1000;
const ay = t => { const s = Math.sin(Math.PI * (t - SUN.rise) / (SUN.set - SUN.rise)); return ARC.hz - ARC.A * (s >= 0 ? s : s * ARC.below); };
const apath = (a, b, step = 4) => { a = Math.max(ARC.t0, a); b = Math.min(ARC.t1, b); if (b <= a) return ''; let d = ''; for (let t = a; ; t += step) { const tt = Math.min(t, b); d += (d ? 'L' : 'M') + ax(tt).toFixed(1) + ' ' + ay(tt).toFixed(1); if (tt >= b) break; } return d; };
const sunAt = t => ({ x: ax(t) / 10, y: ARC.top + ay(t) * ARC.k });

function dagboog() {
  const stars = Array.from({ length: 22 }, (_, i) => { const x = (i * 47.3 + 13) % 100, y = (i * 29.7 + 7) % 62, o = .35 + ((i * 37) % 60) / 100; return `<i style="left:${x.toFixed(1)}%;top:${y.toFixed(1)}%;opacity:${o.toFixed(2)}"></i>`; }).join('');
  const evs = TODAY.map((ev, i) => `<path class="arc-p arc-ev${ev.kind === 'focus' ? ' focus' : ''}" data-ev="${i}" d="${apath(ev.s, ev.e, 2)}" stroke="${evColor(ev)}"></path>`).join('');
  const lane = TODAY.map((ev, i) => { const row = ev.kind === 'focus' ? 1 : 0; return `<button class="ev${ev.kind === 'focus' ? ' focus' : ''}" data-evjump="${i}" style="left:calc(${(ax(ev.s) / 10).toFixed(2)}% - 4px);top:${row * 30}px;--c:${evColor(ev)};--wp:${((ev.e - ev.s) / (ARC.t1 - ARC.t0) * 100).toFixed(2)}" title="${hm(ev.s)} – ${hm(ev.e)} · ${ev.t}"><i></i>${ev.short}</button>`; }).join('');
  const ticks = [480, 600, 720, 840, 960, 1080, 1200].map(t => `<span style="left:${(ax(t) / 10).toFixed(2)}%">${hm(t)}</span>`).join('');
  const zx = ax(SUN.noon) / 10, zy = ARC.top + ay(SUN.noon) * ARC.k;
  const hzY = ARC.top + ARC.hz * ARC.k;
  return `<section class="arc-card" id="arc" data-note="arc">
    <div class="arc-stars">${stars}</div>
    <div class="arc-head">
      <h2 class="card-t">${ic('sun')}Dagboog</h2>
      <span class="meta">Lopik · zon op ${hm(SUN.rise)} · zenit ${hm(SUN.noon)} · onder ${hm(SUN.set)}</span>
      <div class="ctl"><span class="meta" style="margin-right:4px">Sleep de zon</span>
        <button class="btn btn-2 btn-sm" data-act="play" id="playbtn">${ic('play')}Speel de dag af</button>
        <button class="btn btn-ghost btn-sm" data-act="now">${ic('rotate-ccw')}Nu</button></div>
    </div>
    <div class="arc-stage" id="stage">
      <svg class="arc-svg" viewBox="0 0 1000 200" preserveAspectRatio="none" aria-hidden="true">
        <line class="arc-hz" x1="0" y1="${ARC.hz}" x2="1000" y2="${ARC.hz}"></line>
        <path class="arc-p arc-night" d="${apath(ARC.t0, SUN.rise)}"></path>
        <path class="arc-p arc-night" d="${apath(SUN.set, ARC.t1)}"></path>
        <path class="arc-p arc-day" d="${apath(SUN.rise, SUN.set)}"></path>
        <path class="arc-p arc-past" id="arcpast" d=""></path>
        ${evs}
      </svg>
      <span class="arc-mk zenit" style="left:${zx.toFixed(2)}%;top:${(zy - 34).toFixed(1)}px">Zenit ${hm(SUN.noon)}</span>
      <span class="arc-mk" style="left:${(ax(SUN.rise) / 10).toFixed(2)}%;top:${(hzY + 8).toFixed(1)}px">${ic('sunrise')}${hm(SUN.rise)}</span>
      <span class="arc-mk" style="left:${(ax(SUN.set) / 10).toFixed(2)}%;top:${(hzY + 8).toFixed(1)}px">${ic('sunset')}${hm(SUN.set)}</span>
      <button class="arc-sun" id="sun" role="slider" aria-label="Tijd van de dag" aria-valuemin="${ARC.t0}" aria-valuemax="${ARC.t1}"><span class="arc-sun-t" id="suntime"></span></button>
    </div>
    <div class="arc-ticks">${ticks}</div>
    <div class="arc-lane">${lane}<span style="position:absolute;left:0;top:7px;font-size:10.5px;color:var(--ink-3)">Afspraken</span><span style="position:absolute;left:0;top:37px;font-size:10.5px;color:var(--ink-3)">Focus</span></div>
    <div class="nn" id="nn"></div>
  </section>`;
}

function nowNext(t) {
  const cur = TODAY.find(e => e.s <= t && t < e.e);
  const next = TODAY.find(e => e.s > t);
  const left = TODAY.filter(e => e.s > t);
  const meets = left.filter(e => e.kind !== 'focus').length;
  const joinBtn = e => e.join === 'video' ? `<button class="btn btn-2 btn-sm" data-act="nyi" data-what="Deelnemen aan de videovergadering">${ic('video')}Deelnemen</button>` : e.join === 'route' ? `<button class="btn btn-2 btn-sm" data-act="nyi" data-what="De route">${ic('map-pin')}Route</button>` : e.join === 'call' ? `<button class="btn btn-2 btn-sm" data-act="nyi" data-what="Bellen">${ic('phone')}Bellen</button>` : '';
  const proj = e => e.p ? PROJECTS[e.p].name : e.where || '';
  let nu;
  if (cur) { const p = (t - cur.s) / (cur.e - cur.s); nu = `<span class="nn-l now">Nu</span><div class="nn-b"><div class="nn-t">${cur.kind === 'focus' ? 'Focus · ' : ''}${cur.t}</div><div class="nn-m"><span class="bar"><span style="--v:${(p * 100).toFixed(0)}%"></span></span>nog ${dur(Math.max(1, Math.round(cur.e - t)))} · ${proj(cur)}</div></div>`; }
  else if (t < TODAY[0].s) nu = `<span class="nn-l now">Nu</span><div class="nn-b"><div class="nn-t">Nog niets gepland</div><div class="nn-m">Je dag begint om ${hm(TODAY[0].s)}</div></div>`;
  else if (!next) nu = `<span class="nn-l now">Nu</span><div class="nn-b"><div class="nn-t">Werkdag klaar</div><div class="nn-m">${t >= SUN.set ? 'De zon is onder · tijd voor jezelf' : 'Niets meer gepland vandaag'}</div></div>`;
  else nu = `<span class="nn-l now">Nu</span><div class="nn-b"><div class="nn-t">Vrij tot ${hm(next.s)}</div><div class="nn-m">${dur(Math.round(next.s - t))} zonder afspraken</div></div>`;
  const vo = next
    ? `<span class="nn-l">Volgende</span><div class="nn-b"><div class="nn-t">${hm(next.s)} · ${next.t}</div><div class="nn-m">over ${dur(Math.max(1, Math.round(next.s - t)))} · ${next.where || proj(next)}</div></div>${joinBtn(next)}`
    : `<span class="nn-l">Morgen</span><div class="nn-b"><div class="nn-t">09:00 · Fotoshoot Bloem</div><div class="nn-m">Restaurant Bloem · drie uur</div></div>`;
  const dag = `<div class="nn-b" style="align-items:flex-end;text-align:right"><div class="nn-t">${left.length ? `Nog ${meets} afspra${meets === 1 ? 'ak' : 'ken'}` : 'Alles gehad'}</div><div class="nn-m">${left.length ? `${left.length - meets} focusblok${left.length - meets === 1 ? '' : 'ken'} · klaar ± ${hm(TODAY[TODAY.length - 1].e)}` : 'Morgen weer een dag'}</div></div>`;
  return `<div>${nu}</div><div>${vo}</div><div>${dag}</div>`;
}

function setTime(t, from) {
  t = Math.max(ARC.t0, Math.min(ARC.t1, t));
  S.time = t;
  const card = $('#arc');
  if (card) {
    const p = sunAt(t), sun = $('#sun');
    sun.style.left = p.x + '%'; sun.style.top = p.y + 'px';
    $('#suntime').textContent = hm(t);
    sun.setAttribute('aria-valuenow', Math.round(t)); sun.setAttribute('aria-valuetext', hm(t));
    $('#arcpast').setAttribute('d', t > SUN.rise ? apath(SUN.rise, Math.min(t, SUN.set)) : '');
    card.classList.toggle('is-night', !isDay(t));
    card.style.setProperty('--night', isDay(t) ? 0 : 1);
    $$('.arc-ev', card).forEach(el => el.classList.toggle('past', TODAY[+el.dataset.ev].e <= t));
    $$('.ev', card).forEach(el => { const ev = TODAY[+el.dataset.evjump]; el.classList.toggle('past', ev.e <= t); el.classList.toggle('now', ev.s <= t && t < ev.e); });
    $('#nn').innerHTML = nowNext(t);
    const g = $('#greet'); if (g) g.innerHTML = `${greet(t)}, <em>Gerjan</em>`;
  }
  sunTheme(from);
}
function sunScreenPoint() {
  const s = $('#sun'); if (!s) return null;
  const r = s.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}
let sunTheme = () => {};

let playRaf = 0;
function play() {
  const btn = $('#playbtn');
  if (S.playing) { stopPlay(); return; }
  S.playing = true; $('#stage')?.classList.add('is-playing');
  if (btn) btn.innerHTML = `${ic('pause')}Pauze`;
  let from = S.time >= ARC.t1 - 30 ? SUN.rise - 30 : S.time;
  const total = ARC.t1 - from, ms = reduced() ? 1 : Math.max(2500, total / 60 * 620);
  const t0 = performance.now();
  const step = now => {
    const k = Math.min(1, (now - t0) / ms);
    setTime(from + total * k);
    if (k < 1 && S.playing) playRaf = requestAnimationFrame(step); else stopPlay();
  };
  playRaf = requestAnimationFrame(step);
}
function stopPlay() {
  S.playing = false; cancelAnimationFrame(playRaf);
  $('#stage')?.classList.remove('is-playing');
  const btn = $('#playbtn'); if (btn) btn.innerHTML = `${ic('play')}Speel de dag af`;
}
function tweenTime(to, ms = 650) {
  stopPlay();
  const from = S.time, t0 = performance.now();
  if (reduced()) { setTime(to); return; }
  $('#stage')?.classList.add('is-playing');
  const ease = k => 1 - Math.pow(1 - k, 3);
  const step = now => { const k = Math.min(1, (now - t0) / ms); setTime(from + (to - from) * ease(k)); if (k < 1) requestAnimationFrame(step); else $('#stage')?.classList.remove('is-playing'); };
  requestAnimationFrame(step);
}
function mountArc() {
  const stage = $('#stage'); if (!stage) return;
  setTime(S.time);
  const toT = e => { const r = stage.getBoundingClientRect(); return ARC.t0 + Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * (ARC.t1 - ARC.t0); };
  let drag = false;
  stage.addEventListener('pointerdown', e => { if (e.button !== 0) return; stopPlay(); drag = true; stage.setPointerCapture(e.pointerId); stage.classList.add('is-drag'); setTime(toT(e)); e.preventDefault(); });
  stage.addEventListener('pointermove', e => { if (drag) setTime(toT(e)); });
  const end = () => { drag = false; stage.classList.remove('is-drag'); };
  stage.addEventListener('pointerup', end); stage.addEventListener('pointercancel', end);
  $('#sun').addEventListener('keydown', e => {
    const k = { ArrowLeft: -5, ArrowRight: 5, ArrowDown: -5, ArrowUp: 5, PageDown: -60, PageUp: 60 }[e.key];
    if (k) { setTime(S.time + (e.shiftKey ? k * 6 : k)); e.preventDefault(); }
    if (e.key === 'Home') { setTime(SUN.rise); e.preventDefault(); }
    if (e.key === 'End') { setTime(SUN.set); e.preventDefault(); }
  });
}

function decideCard() {
  const items = S.decisions.map(id => DECISIONS.find(d => d.id === id));
  return `<div class="card-h"><span class="orb"></span><div><h2 class="card-t">Te beslissen <span class="count" data-count="dec" style="margin-left:4px;vertical-align:2px"></span></h2><p class="card-s">Klaargezet door Gerrie en je agents</p></div><button class="link more" data-go="gerrie">Alles bekijken ${ic('arrow-right')}</button></div>
  ${items.length ? items.map(d => `<div class="dec" data-dec="${d.id}"><span class="glyph${d.run ? ' run' : ''}">${ic(d.icon)}</span><div class="dec-b"><div class="dec-t">${d.title}</div><div class="dec-w">${d.why}</div></div><div class="dec-a"><button class="btn btn-ai btn-sm" data-opendec="${d.id}">${ic('sparkles')}${d.cta}</button><button class="btn-icon" data-approve="${d.id}" aria-label="Akkoord: ${d.title}" title="Akkoord">${ic('check')}</button></div></div>`).join('')
    : `<div class="empty"><span class="glyph run">${ic('check-check')}</span><b>Alles beslist</b>Gerrie houdt de wacht. Volgende ronde om 13:00.</div>`}
  <div class="trust">${ic('shield-check')}Er gaat niets de deur uit zonder jouw akkoord.<button class="link" data-act="nyi" data-what="Het logboek">Logboek ${ic('arrow-right')}</button></div>`;
}

function spark(vals, w, h) {
  const mx = Math.max(...vals), mn = Math.min(...vals) * .8;
  const pts = vals.map((v, i) => [i / (vals.length - 1) * w, h - 3 - (v - mn) / (mx - mn) * (h - 7)]);
  const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('');
  const last = pts[pts.length - 1];
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none" aria-hidden="true" style="display:block;overflow:visible"><defs><linearGradient id="spk" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--gold)" stop-opacity=".28"></stop><stop offset="1" stop-color="var(--gold)" stop-opacity="0"></stop></linearGradient></defs><path d="${line}L${w} ${h}L0 ${h}Z" fill="url(#spk)"></path><path d="${line}" fill="none" stroke="var(--gold)" stroke-width="1.75" vector-effect="non-scaling-stroke" stroke-linejoin="round"></path><circle cx="${last[0]}" cy="${last[1]}" r="3" fill="var(--gold)" stroke="var(--surface)" stroke-width="1.5" vector-effect="non-scaling-stroke"></circle></svg>`;
}
function puls() {
  return `<div class="puls">
    <div class="pm"><div class="pm-l">${ic('trending-up')}Gefactureerd in oktober</div><div class="pm-v">${eur(9196)}</div><div style="margin-top:10px">${spark(SPARK, 160, 26)}</div><div class="pm-s"><span class="up">${ic('arrow-up-right', 'i-xs')}24%</span>t.o.v. september</div></div>
    <div class="pm"><div class="pm-l">${ic('hourglass')}Openstaand</div><div class="pm-v">${eur(3690.5)}</div><div class="pm-split" aria-hidden="true" style="margin-top:20px"><i style="flex:2904;background:var(--ink-3)"></i><i style="flex:786.5;background:var(--danger)"></i></div><div class="pm-s" style="margin-top:12px">2 facturen · <span style="color:var(--danger);font-weight:500">€ 786,50 te laat</span></div></div>
    <div class="pm"><div class="pm-l">${ic('timer')}Uren deze week</div><div class="pm-v">26,5<span class="u">van 32 u</span></div><div class="bar" style="margin-top:20px"><span style="--v:${(26.5 / 32 * 100).toFixed(0)}%"></span></div><div class="pm-s" style="margin-top:12px">22 u declarabel · € 1.870</div></div>
    <div class="pm"><div class="pm-l">${ic('file-text')}In de pijplijn</div><div class="pm-v">${eur(7780.3)}</div><div class="pm-split" aria-hidden="true" style="margin-top:20px"><i style="flex:3327.5;background:var(--gold)"></i><i style="flex:4452.8;background:var(--surface-3)"></i></div><div class="pm-s" style="margin-top:12px">2 offertes · 1 bij de klant</div></div>
  </div>`;
}

function taskRow(t) {
  const p = PROJECTS[t.p];
  return `<div class="task${t.done ? ' done' : ''}" data-task="${t.id}" draggable="true"><span class="grip" aria-hidden="true">${ic('grip-vertical', 'i-sm')}</span><button class="chk" data-check="${t.id}" role="checkbox" aria-checked="${!!t.done}" aria-label="${t.t}"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.2 5 8.6l4.6-5"></path></svg></button><div style="min-width:0"><div class="task-t">${t.t}</div><div class="task-p"><span class="dot" style="--c:${p.color}"></span>${p.name}</div></div><span class="est">${dur(t.est)}</span><span class="when ${t.done ? '' : (t.cls || '')}">${t.done ? 'Klaar' : t.when}</span></div>`;
}
function tasksCard() {
  const open = S.tasks.filter(t => !t.done);
  const late = S.tasks.filter(t => t.group === 'late'), today = S.tasks.filter(t => t.group === 'today');
  return `<div class="card-h"><div><h2 class="card-t">Vandaag te doen</h2><p class="card-s" id="tasksum">${open.length} open · ± ${dur(open.reduce((a, t) => a + t.est, 0))} werk</p></div><button class="link more" data-act="nyi" data-what="De weekplanner">Weekplanner ${ic('arrow-right')}</button></div>
  ${late.length ? `<div class="tgroup late">${ic('triangle-alert', 'i-sm')}Blijft liggen</div><div class="tlist" data-group="late">${late.map(taskRow).join('')}</div>` : ''}
  <div class="tgroup">Gepland voor vandaag</div><div class="tlist" data-group="today">${today.map(taskRow).join('')}</div>`;
}

function flowCard() {
  const W = 420, H = 168, L = 38, R = 12, T = 16, B = 24;
  const xs = d => L + (d + 30) / 60 * (W - L - R);
  const y0 = 6000, y1 = 22000, ys = v => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
  const P = pts => pts.map((p, i) => (i ? 'L' : 'M') + xs(p[0]).toFixed(1) + ' ' + ys(p[1]).toFixed(1)).join('');
  const f = CASH.future;
  const band = f.map(p => [p[0], p[1] + p[2]]).concat(f.slice().reverse().map(p => [p[0], p[1] - p[2]]));
  const grid = [10000, 14000, 18000, 22000].map(v => `<line class="gl" x1="${L}" x2="${W - R}" y1="${ys(v).toFixed(1)}" y2="${ys(v).toFixed(1)}"></line><text class="ax" x="${L - 6}" y="${(ys(v) + 3).toFixed(1)}" text-anchor="end">${v / 1000}k</text>`).join('');
  const lbls = f.filter(p => p[3] && ['Korenaar', 'Loon', 'Fase 2'].includes(p[4])).map(p => { const up = p[3][0] === '+'; const x = xs(p[0]), y = ys(p[1]); return `<circle class="evd" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.5" stroke="${up ? 'var(--ok)' : 'var(--danger)'}"></circle><text class="lbl" x="${x.toFixed(1)}" y="${(up ? y - 9 : y + 16).toFixed(1)}" text-anchor="${p[0] > 25 ? 'end' : 'middle'}">${p[3]} ${p[4]}</text>`; }).join('');
  const nx = xs(0), ny = ys(CASH.now);
  const svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Saldo: nu € 14.380, verwacht rond € 18.000 op 21 november">
    <defs><linearGradient id="fcStroke" gradientUnits="userSpaceOnUse" x1="${nx}" x2="${W - R}" y1="0" y2="0"><stop offset="0" stop-color="var(--ai-1)"></stop><stop offset="1" stop-color="var(--ai-2)"></stop></linearGradient></defs>
    ${grid}
    <path class="band" d="${P(band)}Z"></path>
    <path class="act" d="${P(CASH.past)}"></path>
    <path class="fc" d="${P(f)}"></path>
    <line class="now" x1="${nx}" x2="${nx}" y1="${T - 4}" y2="${H - B}"></line>
    ${lbls}
    <circle class="nowdot" cx="${nx}" cy="${ny.toFixed(1)}" r="4.5"></circle>
    <text class="ax" x="${L}" y="${H - 6}">22 sep</text><text class="ax" x="${nx}" y="${H - 6}" text-anchor="middle" style="fill:var(--gold-ink);font-weight:600">vandaag</text><text class="ax" x="${W - R}" y="${H - 6}" text-anchor="end">21 nov</text>
  </svg>`;
  return `<div class="card-h"><div><h2 class="card-t">Geldstroom</h2><p class="card-s">Saldo ABN AMRO · 30 dagen terug en vooruit</p></div><button class="link more" data-act="nyi" data-what="Bank">Bank ${ic('arrow-right')}</button></div>
  <div class="flow-top"><div><div class="flow-v">${eur(14380, false)}</div><div class="card-s" style="margin-top:6px">nu op de rekening</div></div><span style="color:var(--ink-4);padding-bottom:16px">${ic('arrow-right')}</span><div class="flow-to"><span style="display:flex;align-items:center;gap:6px"><span class="orb sm"></span>Gerrie verwacht op 21 nov</span><b>≈ € 18.000 <span style="font-weight:500;font-size:12px;color:var(--ink-3)">± € 1.400</span></b></div></div>
  ${svg}
  <div class="legend"><span><i></i>Werkelijk</span><span><i class="fc"></i>Verwacht</span><span><i class="band"></i>Bandbreedte</span></div>`;
}

function vVandaag() {
  return `<div class="vh">
    <div>
      <div class="vh-eb"><span class="sun-dot"></span>Donderdag 22 oktober · week 43</div>
      <h1 class="vh-t" id="greet">${greet(S.time)}, <em>Gerjan</em></h1>
      <p class="vh-s"><b>4 afspraken</b> en <b>3 focusblokken</b>. Factuur 2026-040 is 10 dagen over tijd en Gerrie heeft <b data-count="dec-txt"></b> klaar.</p>
    </div>
    <div class="vh-a">
      <div class="seg" role="group" aria-label="Wiens dag"><button aria-pressed="true">Mijn dag</button><button aria-pressed="false" data-act="nyi" data-what="De teamweergave">Team</button></div>
      <button class="btn btn-gold" data-act="cmdk-new">${ic('plus')}Nieuw</button>
    </div>
  </div>
  ${dagboog()}
  <div class="grid">
    <section class="card decide c7" id="decide">${decideCard()}</section>
    <section class="card c5" data-note="puls"><div class="card-h"><div><h2 class="card-t">Puls</h2><p class="card-s">Oktober tot nu · bijgewerkt 09:30</p></div><button class="link more" data-act="nyi" data-what="Statistieken">Inzicht ${ic('arrow-right')}</button></div>${puls()}</section>
    <section class="card c7 tasks" id="tasks">${tasksCard()}</section>
    <section class="card c5 flow">${flowCard()}</section>
  </div>`;
}

/* ══ Klant 360 ══ */
function vKlant() {
  const c = CLIENTS.korenaar;
  const tabs = [['overzicht', 'Overzicht'], ['tijdlijn', 'Tijdlijn', 24], ['projecten', 'Projecten', 1], ['geld', 'Geld', 3], ['bestanden', 'Bestanden', 12], ['notities', 'Notities', 4]];
  const tl = TIMELINE.map(g => `<div class="tl-day">${g.day}</div>${g.items.map(it => `<div class="tl-it"><span class="tl-ic ${it.cls || ''}">${ic(it.ic)}</span><div><div class="tl-t">${it.t}</div><div class="tl-s">${it.s}</div>${it.q ? `<div class="tl-q">${it.q}</div>` : ''}</div><span class="tl-time">${it.time}</span></div>`).join('')}`).join('');
  return `<nav class="crumbs" aria-label="Kruimelpad" style="margin-bottom:14px"><button data-go="klant">Klanten</button>${ic('chevron-right')}<span style="color:var(--ink-2)">${c.name}</span></nav>
  <section class="khero" style="--cc:${c.color}">
    <div class="khero-top">
      <div class="cl-tile">${c.ini}</div>
      <div style="min-width:0"><h1>${c.name}</h1><div class="khero-meta"><span class="pill ok">${c.status}</span><span>${c.code}</span><span class="sep"></span><span>${c.contact}, ${c.role.toLowerCase()}</span><span class="sep"></span><span>Lopik</span><span class="pill">retail</span><span class="pill">huisstijl</span></div></div>
      <div class="khero-a"><button class="btn btn-2" data-act="nyi" data-what="Bellen via je telefoon">${ic('phone')}Bellen</button><button class="btn btn-2" data-act="nyi" data-what="Een mail aan Joost">${ic('mail')}Mail</button><button class="btn btn-gold" data-act="cmdk-fill" data-fill="factuur korenaar ">${ic('plus')}Nieuw</button></div>
    </div>
    <div class="kv">
      <div><span>Relatiewaarde</span><b>${eur(18500, false)}</b></div>
      <div><span>Openstaand</span><b>${eur(2904)}<span class="pill info" style="font-size:11px">vervalt 28 okt</span></b></div>
      <div><span>Lopend werk</span><b>1 project · 35%</b></div>
      <div><span>Relatiepuls</span><b><span class="pulse-dots" aria-hidden="true"><i class="on"></i><i class="on"></i><i class="on"></i><i class="on"></i><i></i></span>Warm</b></div>
    </div>
  </section>
  <div class="subtabs" role="tablist">${tabs.map(([k, l, n]) => `<button role="tab" aria-selected="${S.ktab === k}" data-ktab="${k}">${l}${n ? `<span class="n">${n}</span>` : ''}</button>`).join('')}</div>
  <div class="grid">
    <section class="card c7" data-note="k-tl"><div class="card-h"><div><h2 class="card-t">Tijdlijn</h2><p class="card-s">Mail, chat, agenda, offertes en facturen op één lijn</p></div><div class="seg more" role="group" aria-label="Filter"><button aria-pressed="true">Alles</button><button aria-pressed="false" data-act="nyi" data-what="Filteren op mail">Mail</button><button aria-pressed="false" data-act="nyi" data-what="Filteren op geld">Geld</button></div></div><div class="tl">${tl}</div></section>
    <div class="side c5">
      <section class="card ai-card" data-note="k-ai"><div class="card-h"><span class="orb"></span><div><h2 class="card-t">Gerrie over De Korenaar</h2><p class="card-s">Uit 24 contactmomenten · bijgewerkt 08:00</p></div></div>
        <p class="ai-txt">Joost reageert meestal <b>binnen 4 uur</b> en belt liever dan dat hij mailt. Hij koos dinsdag voor <b>richting C</b>; Sanne meldt dat hij de definitieve logobestanden <b>vóór de lunch</b> wil zien. Volgende mijlpaal: <b>drukproef briefpapier</b>, morgen.</p>
        <div class="ai-acts"><button class="btn btn-ai btn-sm" data-act="nyi" data-what="Een agenda voor het overleg van 10:00">${ic('sparkles')}Agenda voor 10:00 maken</button><button class="btn btn-2 btn-sm" data-act="nyi" data-what="Bestanden versturen">${ic('send')}Bestanden sturen</button></div></section>
      <section class="card mini"><h2 class="card-t" style="margin-bottom:8px">Geld</h2>
        <div class="mini-row"><span>Offerte 2026-019</span><b>${eur(6957.5)} <span class="pill ok" style="margin-left:4px">geaccepteerd</span></b></div>
        <div class="mini-row"><span>Gefactureerd</span><b>${eur(2904)} · 42%</b></div>
        <div class="mini-row"><span>Nog te factureren</span><b>${eur(4053.5)}</b></div>
        <div class="bar" style="margin-top:10px"><span style="--v:42%"></span></div></section>
      <section class="card mini" style="cursor:pointer" data-go="project"><div style="display:flex;align-items:center;gap:10px"><span class="dot" style="--c:${c.color};width:10px;height:10px"></span><h2 class="card-t">Nieuwe huisstijl De Korenaar</h2><span style="margin-left:auto;color:var(--ink-3)">${ic('arrow-up-right')}</span></div>
        <div class="mini-row" style="margin-top:8px"><span>Voortgang</span><b>35% · 14 van 40 uur</b></div>
        <div class="mini-row"><span>Team</span><span class="avs"><span class="av" style="--s:22px">GL</span><span class="av av-sb" style="--s:22px">SB</span><span class="av av-db" style="--s:22px">DB</span></span></div></section>
    </div>
  </div>`;
}

/* ══ Project ══ */
function kcard(k, lane) {
  return `<div class="kc${lane === 'done' ? ' done' : ''}" draggable="true" data-kc="${k.id}" tabindex="0"><div class="kc-t">${k.t}</div>${k.tags ? `<div class="kc-tags">${k.tags.map(([l, c]) => `<span class="pill ${c}">${l}</span>`).join('')}</div>` : ''}<div class="kc-m">${ic('clock', 'i-sm')}${k.est}<span>·</span>${k.due}<span class="avs">${k.who.map(w => `<span class="av ${PEOPLE[w][1]}">${PEOPLE[w][0]}</span>`).join('')}</span></div></div>`;
}
function vProject() {
  const lanes = LANES.map(([k, l]) => `<div class="lane" data-lane="${k}"><div class="lane-h">${l}<span class="count muted">${S.board[k].length}</span><button class="btn-icon" data-act="cmdk-fill" data-fill="taak " aria-label="Taak toevoegen aan ${l}">${ic('plus', 'i-sm')}</button></div>
    ${k === 'todo' && S.ghost ? `<div class="kc ghost" data-note="p-ghost"><div class="kc-t">${ic('sparkles', 'i-sm i-ai')}Subtaak: afloop rechtsonder ruimer</div><div class="kc-s">Daan in de teamchat: “Let op de afloop rechtsonder, die was vorige keer te krap.” Toevoegen aan <b>Drukproef briefpapier</b>?</div><div class="acts"><button class="btn btn-ai btn-sm" data-act="ghost-yes">Toevoegen</button><button class="btn btn-ghost btn-sm" data-act="ghost-no">Nee</button></div></div>` : ''}
    ${S.board[k].map(c => kcard(c, k)).join('')}</div>`).join('');
  const done = S.board.done.length, all = LANES.reduce((a, [k]) => a + S.board[k].length, 0);
  return `<nav class="crumbs" aria-label="Kruimelpad" style="margin-bottom:12px"><button data-go="project">Projecten</button>${ic('chevron-right')}<span style="color:var(--ink-2)">Nieuwe huisstijl De Korenaar</span></nav>
  <div class="vh"><div><div class="vh-eb"><span class="dot" style="--c:#FFD966"></span>Bakkerij De Korenaar · 2 oktober tot 16 november</div><h1 class="vh-t">Nieuwe huisstijl De Korenaar</h1></div>
    <div class="vh-a"><span class="avs"><span class="av">GL</span><span class="av av-sb">SB</span><span class="av av-db">DB</span></span><div class="seg" role="group" aria-label="Weergave"><button aria-pressed="true">${ic('kanban')}Bord</button><button aria-pressed="false" data-act="nyi" data-what="De lijstweergave">${ic('list')}Lijst</button><button aria-pressed="false" data-act="nyi" data-what="De tijdlijn">${ic('gantt-chart')}Tijdlijn</button></div><button class="btn btn-gold" data-act="cmdk-fill" data-fill="taak ">${ic('plus')}Taak</button></div></div>
  <section class="card meters" data-note="p-meters">
    <div class="meter"><span>Voortgang tegen de tijd</span><b>35% werk · 44% tijd</b><div class="dual" aria-hidden="true"><i class="t" style="width:44%"></i><i class="w" style="width:35%"></i></div><div class="card-s" style="margin-top:9px;color:var(--ai-ink);display:flex;align-items:center;gap:6px"><span class="orb sm"></span>Licht achter: Gerrie stelt voor de visitekaartjes een week op te schuiven</div></div>
    <div class="meter"><span>Uren</span><b>14 van 40 uur</b><div class="bar"><span style="--v:35%"></span></div><div class="card-s" style="margin-top:9px">€ 1.190 van € 3.400 budget</div></div>
    <div class="meter"><span>Taken</span><b id="taskcount">${done} van ${all} klaar</b><div class="bar"><span id="taskbar" style="--v:${(done / all * 100).toFixed(0)}%;--c:var(--ok)"></span></div><div class="card-s" style="margin-top:9px">Volgende: drukproef briefpapier, morgen</div></div>
  </section>
  <div class="board" id="board">${lanes}</div>`;
}

/* ══ Facturen ══ */
function invRows() {
  const q = S.inv.q.toLowerCase();
  return INVOICES.filter(i => (S.inv.f === 'alle' || i.st === S.inv.f) && (!q || (i.n + ' ' + CLIENTS[i.c].name + ' ' + i.d).toLowerCase().includes(q)));
}
function invTable() {
  const rows = invRows();
  if (!rows.length) return `<div class="empty">${ic('search', 'i-xl')}<b>Geen facturen gevonden</b>Pas het filter of de zoekterm aan.</div>`;
  return `<table class="tbl"><thead><tr><th style="width:36px"><span class="sr">Selecteren</span></th><th>Nummer</th><th>Klant</th><th>Omschrijving</th><th>Datum</th><th>Vervalt</th><th class="r">Bedrag</th><th>Status</th></tr></thead><tbody>
  ${rows.map(i => { const c = CLIENTS[i.c], st = INV_ST[i.st], sel = S.inv.sel.has(i.n); return `<tr data-inv="${i.n}" class="${sel ? 'sel' : ''}${S.peek === i.n ? ' is-peek' : ''}"><td><button class="cb" data-sel="${i.n}" role="checkbox" aria-checked="${sel}" aria-label="Selecteer factuur ${i.n}"></button></td><td class="num">${i.n}</td><td><span class="cli"><span class="dot" style="--c:${c.color}"></span>${c.name}</span></td><td class="sub">${i.d}</td><td class="sub">${i.date}</td><td class="sub" ${i.st === 'late' ? 'style="color:var(--danger);font-weight:500"' : ''}>${i.due}</td><td class="r" style="font-weight:600">${eur(i.amt)}</td><td><span class="pill ${st[1]}">${st[0]}</span>${i.note ? `<span class="sub" style="margin-left:8px">${i.note}</span>` : ''}</td></tr>`; }).join('')}
  </tbody></table>`;
}
function vFacturen() {
  const cnt = st => INVOICES.filter(i => st === 'alle' || i.st === st).length;
  const chips = [['alle', 'Alle'], ['concept', 'Concept'], ['open', 'Openstaand'], ['late', 'Te laat'], ['paid', 'Betaald']].map(([k, l]) => `<button class="chipf" aria-pressed="${S.inv.f === k}" data-invf="${k}">${k === 'late' ? '<span class="dot" style="--c:var(--danger)"></span>' : ''}${l}<span class="n">${cnt(k)}</span></button>`).join('');
  const banner = S.decisions.includes('d1') ? `<div class="banner" data-note="f-banner"><span class="orb sm"></span><span><b>Factuur 2026-040 is 10 dagen te laat.</b> Gerrie heeft een herinnering klaarstaan; Karim betaalde de vorige twee binnen twee dagen.</span><span class="acts"><button class="btn btn-2 btn-sm" data-opendec="d1">Bekijk mail</button><button class="btn btn-gold btn-sm" data-approve="d1">${ic('check')}Akkoord</button></span></div>` : '';
  return `<div class="vh"><div><div class="vh-eb">Geld · Verkoop</div><h1 class="vh-t">Facturen</h1><p class="vh-s">Je klanten betalen gemiddeld na <b>11 dagen</b>. Klik op een factuur om hem ernaast te openen.</p></div>
    <div class="vh-a"><button class="btn btn-2" data-act="nyi" data-what="Exporteren naar je boekhouder">${ic('external-link')}Exporteren</button><button class="btn btn-gold" data-act="cmdk-fill" data-fill="factuur ">${ic('plus')}Nieuwe factuur</button></div></div>
  <section class="card sumrow">
    <div><span>${ic('hourglass', 'i-sm')}Openstaand</span><b>${eur(3690.5)}</b></div>
    <div><span style="color:var(--danger)">${ic('triangle-alert', 'i-sm')}Te laat</span><b>${eur(786.5)}</b></div>
    <div><span>${ic('circle-check', 'i-sm')}Betaald in oktober</span><b>${eur(6292)}</b></div>
    <div><span>${ic('pencil', 'i-sm')}In concept</span><b>${eur(423.5)}</b></div>
  </section>
  ${banner}
  <div class="filters" role="group" aria-label="Filter op status">${chips}<label class="search">${ic('search', 'i-sm')}<span class="sr">Zoek in facturen</span><input id="invq" placeholder="Zoek op klant of nummer" value="${S.inv.q}"></label></div>
  <section class="card" style="overflow:hidden" id="invtable" data-note="f-table">${invTable()}</section>`;
}
function renderBulk() {
  const n = S.inv.sel.size, b = $('#bulk');
  if (!b) return;
  b.classList.toggle('on', n > 0 && S.screen === 'facturen');
  if (n) b.innerHTML = `<span>${n} geselecteerd</span><button class="btn" data-act="bulk-pdf">${ic('external-link')}Pdf's</button><button class="btn" data-act="bulk-paid">${ic('circle-check')}Markeer betaald</button><button class="btn btn-gold" data-act="bulk-remind">${ic('bell-ring')}Herinnering klaarzetten</button><button class="btn-icon" data-act="bulk-clear" aria-label="Selectie wissen" style="color:inherit">${ic('x')}</button>`;
}
const INV_LINES = { '2026-038': [['Advies', 6, 85]], '2026-041': [['Huisstijl fase 1', 1, 2400]], '2026-040': [['Content september', 1, 650]], '2026-039': [['Website oplevering', 1, 5200]], '2026-037': [['Content augustus', 1, 650]], '2026-042': [['Onboarding', 1, 350]] };
function openPeek(n) {
  const inv = INVOICES.find(i => i.n === n); if (!inv) return;
  if (S.screen !== 'facturen') go('facturen');
  S.peek = n;
  const c = CLIENTS[inv.c], st = INV_ST[inv.st], lines = INV_LINES[n];
  const sub = lines.reduce((a, l) => a + l[1] * l[2], 0), vat = Math.round(sub * 21) / 100;
  const steps = {
    late: [['ok', 'send', 'Verstuurd aan Karim', '12 sep · 09:02'], ['ok', 'mail-open', 'Geopend', '12 sep · 13:40'], ['bad', 'triangle-alert', 'Vervallen', '12 okt · 10 dagen geleden'], ['ai', 'sparkles', 'Herinnering klaargezet door de Debiteurenbewaker', 'vandaag 08:30']],
    open: [['ok', 'send', 'Verstuurd aan Joost', '10 okt · 09:05'], ['ok', 'mail-open', 'Twee keer geopend', 'laatst 21 okt · 16:40'], ['', 'calendar', 'Vervalt', '28 okt · over 6 dagen']],
    paid: [['ok', 'send', 'Verstuurd', inv.date], ['ok', 'circle-check', inv.note, 'via iDEAL']],
    concept: [['', 'pencil', 'Concept', 'nog niet verstuurd']],
  }[inv.st];
  const foot = {
    late: `<button class="btn btn-ai" data-opendec="d1">${ic('sparkles')}Herinnering bekijken</button><button class="btn btn-2" data-act="nyi" data-what="Markeren als betaald">Markeer betaald</button>`,
    open: `<button class="btn btn-2" data-act="nyi" data-what="Een herinnering plannen">${ic('bell')}Herinnering plannen</button><button class="btn btn-ghost" data-act="nyi" data-what="De pdf">Pdf</button>`,
    paid: `<button class="btn btn-2" data-act="nyi" data-what="De pdf">Pdf</button><button class="btn btn-ghost" data-act="nyi" data-what="Een creditnota">Creditnota</button>`,
    concept: `<button class="btn btn-gold" data-act="nyi" data-what="Versturen">${ic('send')}Versturen</button><button class="btn btn-2" data-act="nyi" data-what="Bewerken">Bewerken</button>`,
  }[inv.st];
  $('#peek').innerHTML = `<div class="peek-h">${ic('receipt')}<b>Factuur ${n}</b><span class="pill ${st[1]}">${st[0]}</span><span class="sp"></span><button class="btn-icon" data-act="nyi" data-what="Openen in een eigen werktab" aria-label="Open in een werktab">${ic('maximize-2', 'i-sm')}</button><button class="btn-icon" data-act="peek-close" aria-label="Spiekpaneel sluiten">${ic('x')}</button></div>
  <div class="peek-b">
    <div class="paper"><div class="paper-h"><span class="paper-logo"><i>SL</i>Studio Lopik</span><small style="text-align:right">Kerkstraat 12, 3411 AB Lopik<br>KvK 12345678 · NL123456789B01</small></div>
      <h3>Factuur ${n}</h3><small>Aan ${c.name} · t.a.v. ${c.contact}<br>Factuurdatum ${inv.date} · vervaldatum ${inv.due}</small>
      <table><thead><tr><th>Omschrijving</th><th class="r">Aantal</th><th class="r">Prijs</th><th class="r">Totaal</th></tr></thead><tbody>${lines.map(l => `<tr><td>${l[0]}</td><td class="r">${l[1]}</td><td class="r">${eurTxt(l[2])}</td><td class="r">${eurTxt(l[1] * l[2])}</td></tr>`).join('')}</tbody>
      <tbody class="tot"><tr><td colspan="3">Subtotaal</td><td class="r">${eurTxt(sub)}</td></tr><tr><td colspan="3">Btw 21%</td><td class="r">${eurTxt(vat)}</td></tr><tr class="big"><td colspan="3">Totaal</td><td class="r">${eurTxt(sub + vat)}</td></tr></tbody></table>
      ${inv.st === 'late' ? `<span class="paper-stamp">10 dagen te laat</span>` : ''}</div>
    <div class="steps">${steps.map(([k, i, t, s]) => `<div class="step ${k}"><i>${ic(i)}</i><div>${t}<br><span>${s}</span></div></div>`).join('')}</div>
  </div>
  <div class="peek-f">${foot}</div>`;
  $('#peek').classList.add('open');
  $$('tr[data-inv]').forEach(tr => tr.classList.toggle('is-peek', tr.dataset.inv === n));
}
function closePeek(silent) {
  S.peek = null;
  const p = $('#peek'); if (p) p.classList.remove('open');
  if (!silent) $$('tr[data-inv]').forEach(tr => tr.classList.remove('is-peek'));
}

/* ══ Agenda ══ */
function vAgenda() {
  const HH = 52, top = 480, hours = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18];
  const days = ['ma 19', 'di 20', 'wo 21', 'do 22', 'vr 23'];
  const block = e => { const y = (e.s - top) / 60 * HH, h = Math.max(15, (e.e - e.s) / 60 * HH - 3); const c = e.c || evColor(e); const tiny = h < 24; return `<div class="we${e.focus || e.kind === 'focus' ? ' focus' : ''}${tiny ? ' tiny' : ''}" style="top:${y}px;height:${h}px;--c:${c}" title="${hm(e.s)} – ${hm(e.e)} · ${e.t}"><b>${tiny ? hm(e.s) + ' ' : ''}${e.t}</b>${h > 30 ? `<span>${hm(e.s)} – ${hm(e.e)}${e.w || e.where ? ' · ' + (e.w || e.where) : ''}</span>` : ''}</div>`; };
  const cols = days.map((d, i) => {
    const evs = i === 3 ? TODAY.map(e => block({ ...e, c: evColor(e) })).join('') : WEEK.filter(e => e.d === i).map(e => block(e)).join('');
    const ai = i === 4 && S.aiSlot ? `<div class="we ai" style="top:${(780 - top) / 60 * HH}px;height:${2 * HH - 3}px" data-note="a-ai"><b>${ic('sparkles', 'i-xs i-ai')} Huisstijlhandboek opzetten</b><span style="color:var(--ink-3)">Voorstel van Gerrie · 13:00 – 15:00</span><br><button class="btn btn-ai btn-sm" data-act="ai-slot">Inplannen</button></div>` : '';
    const now = i === 3 && S.time >= top && S.time <= 1080 ? `<div class="nowline" style="top:${(S.time - top) / 60 * HH}px"></div>` : '';
    return `<div class="wk-col${i === 3 ? ' today' : ''}" style="--hh:${HH}px;height:${HH * 10}px">${evs}${ai}${now}</div>`;
  }).join('');
  return `<div class="vh"><div><div class="vh-eb">Agenda · Studio-agenda en Gerjan</div><h1 class="vh-t">Week 43</h1><p class="vh-s">19 tot 25 oktober · <b>11 afspraken</b> en <b>9 focusblokken</b> · 28 uur gepland</p></div>
    <div class="vh-a"><div class="seg" role="group" aria-label="Periode"><button aria-pressed="false" data-act="nyi" data-what="De dagweergave">Dag</button><button aria-pressed="true">Week</button><button aria-pressed="false" data-act="nyi" data-what="De maandweergave">Maand</button></div><button class="btn btn-2" data-go="vandaag">Vandaag</button><button class="btn btn-gold" data-act="cmdk-fill" data-fill="afspraak ">${ic('plus')}Afspraak</button></div></div>
  ${S.aiSlot ? `<div class="banner"><span class="orb sm"></span><span><b>Vrijdag heb je twee uur vrij na de fotoshoot.</b> Gerrie stelt voor dan het huisstijlhandboek van De Korenaar op te zetten (deadline 6 november).</span><span class="acts"><button class="btn btn-ai btn-sm" data-act="ai-slot">${ic('sparkles')}Inplannen</button></span></div>` : ''}
  <div class="week" data-note="a-week">
    <div class="wk-corner"></div>${days.map((d, i) => `<div class="wk-h${i === 3 ? ' today' : ''}">${d.split(' ')[0]}<b>${d.split(' ')[1]}</b></div>`).join('')}
    <div class="wk-times" style="height:${HH * 10}px">${hours.map((h, i) => i && i < 10 ? `<span style="top:${i * HH}px">${pad(h)}:00</span>` : '').join('')}</div>${cols}
  </div>`;
}

/* ══ Gerrie ══ */
function vGerrie() {
  const mine = S.decisions.map(id => DECISIONS.find(d => d.id === id));
  if (!mine.length) return `<div class="vh"><div><div class="vh-eb">Gerrie · beslissingen</div><h1 class="vh-t">Te beslissen</h1></div></div>
    <section class="card done-state"><span class="orb lg live"></span><h2>Alles beslist</h2><p>Gerrie houdt de wacht. De volgende ronde van je agents is om 13:00.<br>Je krijgt een pushmelding als er iets klaarstaat.</p><div style="display:flex;gap:8px;justify-content:center;margin-top:18px"><button class="btn btn-2" data-act="reset-dec">${ic('rotate-ccw')}Opnieuw bekijken</button><button class="btn btn-gold" data-go="vandaag">Naar vandaag</button></div></section>`;
  if (!S.decisions.includes(S.gsel)) S.gsel = S.decisions[0];
  const d = DECISIONS.find(x => x.id === S.gsel), D = DDETAIL[d.id];
  let prev = '';
  if (D.kind === 'mail') prev = `<div class="mail"><div class="mail-h"><span>Aan</span><b style="font-weight:500">${D.to}</b><span>Onderwerp</span><b>${D.subj}</b></div><div class="mail-b">${D.body.map(p => `<p>${p}</p>`).join('')}</div></div>`;
  if (D.kind === 'hours') prev = `<table class="tbl fit" style="border:1px solid var(--line);border-radius:12px;overflow:hidden;border-collapse:separate"><thead><tr><th>Afspraak</th><th>Project</th><th class="r">Duur</th></tr></thead><tbody>${D.rows.map(r => `<tr style="cursor:default"><td><b style="font-weight:500">${r[0]}</b><br><span class="sub">${r[2]}</span></td><td class="sub">${r[1]}</td><td class="r" style="font-weight:600">${r[3]}</td></tr>`).join('')}</tbody></table>`;
  if (D.kind === 'purchase') prev = `<table class="tbl" style="border:1px solid var(--line);border-radius:12px;overflow:hidden;border-collapse:separate"><thead><tr><th>Leverancier</th><th>Boeking</th><th class="r">Bedrag</th></tr></thead><tbody>${D.rows.map(r => `<tr style="cursor:default"><td style="font-weight:500">${r[0]}</td><td class="sub">${r[1]}</td><td class="r" style="font-weight:600">${r[2]}</td></tr>`).join('')}</tbody></table>`;
  const qi = x => `<button class="q-it${x.id === S.gsel ? ' is-on' : ''}" data-gsel="${x.id}" data-dec="${x.id}"><span class="glyph${x.run ? ' run' : ''}">${ic(x.icon)}</span><span style="min-width:0"><span class="q-t" style="display:block">${x.title}</span><span class="q-s" style="display:block">${x.agent}</span></span></button>`;
  return `<div class="vh"><div><div class="vh-eb">Gerrie · beslissingen</div><h1 class="vh-t">Te beslissen</h1><p class="vh-s"><b data-count="dec-txt"></b> voor jou. Beslis met een klik of met je toetsenbord: <kbd>A</kbd> akkoord, <kbd>L</kbd> later, <kbd>N</kbd> niet meer.</p></div>
    <div class="vh-a"><button class="btn btn-2" data-act="nyi" data-what="Een nieuwe agent">${ic('bot')}Nieuwe agent</button></div></div>
  <div class="gx">
    <section class="card q" data-note="g-q"><div class="q-h"><h2 class="card-t">Voor jou</h2><span class="count" data-count="dec"></span></div>${mine.map(qi).join('')}
      <div class="q-sep">Van je team · wacht op hen</div>${TEAM_DECISIONS.map(x => `<div class="q-it" style="opacity:.75;cursor:default"><span class="glyph">${ic(x.icon)}</span><span style="min-width:0"><span class="q-t" style="display:block">${x.title}</span><span class="q-s" style="display:block">${x.owner} · ${x.agent}</span></span></div>`).join('')}</section>
    <section class="card dcard" data-dec="${d.id}" data-note="g-card">
      <div class="dcard-h"><span class="glyph${d.run ? ' run' : ''}">${ic(d.icon)}</span><div style="min-width:0"><h2>${d.title}</h2><p>${D.sub}</p></div></div>
      <div class="dsec"><div class="dsec-h">Waarom nu</div><div class="dfacts">${D.facts.map(([a, b]) => `<div class="fact"><span>${a}</span><b>${b}</b></div>`).join('')}</div></div>
      <div class="dsec"><div class="dsec-h">Wat er gebeurt als je akkoord geeft</div>${prev}</div>
      <div class="dact"><button class="btn btn-gold" data-approve="${d.id}">${ic('check')}Akkoord<kbd>A</kbd></button><button class="btn btn-2" data-act="nyi" data-what="Aanpassen in de editor" title="Aanpassen (E)">${ic('pencil')}Aanpassen</button><span class="sp"></span><button class="btn btn-ghost btn-sm" data-later="${d.id}" title="Later (L)">Later</button><button class="btn btn-ghost btn-sm" data-mute="${d.id}" title="Niet meer (N)">Niet meer</button><span class="note">${ic('shield-check', 'i-sm')}Uitvoeren gebeurt onder jouw account, met jouw rechten. ${DDETAIL[d.id].kind === 'mail' ? 'De mail gaat pas na tien seconden de deur uit.' : 'Je kunt het daarna nog terugdraaien.'}</span></div>
    </section>
    <div class="side">
      <section class="card agents" data-note="g-agents"><div class="q-h"><h2 class="card-t">Je agents</h2><span class="card-s" style="margin:0 0 0 auto">3 actief</span></div>${AGENTS.map(a => `<div class="ag"><span class="glyph${a.run ? ' run' : ''}">${ic(a.icon)}</span><div style="min-width:0"><b>${a.name}</b><span>${a.when}</span><span class="st${a.idle ? ' idle' : ''}">${a.st}</span></div></div>`).join('')}
        <div class="month"><div class="dsec-h" style="margin-bottom:6px">Deze maand</div><div class="month-row"><span>Voorstellen</span><b>31</b></div><div class="month-row"><span>Goedgekeurd</span><b>26 · 84%</b></div><div class="month-row"><span>Tijd bespaard</span><b>± 6 uur</b></div></div></section>
    </div>
  </div>`;
}

function vPlaceholder() {
  const m = SCREENS[S.screen];
  return `<section class="card done-state" style="margin-top:40px"><span class="glyph" style="width:56px;height:56px;border-radius:18px;margin:0 auto 16px">${ic(m.ic, 'i-xl')}</span><h2>${m.label}</h2><p>Dit scherm is in het prototype niet uitgewerkt. Het volgt hetzelfde systeem:<br>contextpaneel links, lijst in het werkvlak, details in het spiekpaneel.</p><div style="display:flex;gap:8px;justify-content:center;margin-top:18px"><button class="btn btn-2" data-go="facturen">Bekijk Facturen</button><button class="btn btn-gold" data-go="vandaag">Naar vandaag</button></div></section>`;
}

const VIEWS = { vandaag: vVandaag, klant: vKlant, project: vProject, facturen: vFacturen, agenda: vAgenda, gerrie: vGerrie, berichten: vPlaceholder, inzicht: vPlaceholder };
const MOUNT = {
  vandaag() { mountArc(); },
  facturen() { renderBulk(); const q = $('#invq'); q && q.addEventListener('input', () => { S.inv.q = q.value; $('#invtable').innerHTML = invTable(); }); },
};

/* ── Beslissen ── */
function decide(id, how) {
  const d = DECISIONS.find(x => x.id === id); const idx = S.decisions.indexOf(id);
  if (!d || idx < 0) return;
  $$(`[data-dec="${id}"]`).forEach(el => el.classList.add('out'));
  setTimeout(() => {
    S.decisions = S.decisions.filter(x => x !== id);
    if (S.gsel === id) S.gsel = S.decisions[Math.min(idx, S.decisions.length - 1)];
    refreshDecisions();
  }, reduced() ? 0 : 240);
  const undo = () => { if (!S.decisions.includes(id)) { S.decisions.splice(Math.min(idx, S.decisions.length), 0, id); S.gsel = id; refreshDecisions(); } };
  if (how === 'later') toast('Komt morgen om 08:30 terug', { icon: 'clock', undo });
  else if (how === 'mute') toast('Gedempt: dit soort voorstel komt niet meer', { icon: 'bell', undo });
  else if (DDETAIL[id].kind === 'mail') toast(d.done, { icon: 'send', undo, delay: 10, pending: d.pending });
  else toast(d.done, { icon: 'circle-check', iconCls: 'ok', undo });
}
function refreshDecisions() {
  if (S.screen === 'vandaag') { const c = $('#decide'); if (c) c.innerHTML = decideCard(); }
  else if (S.screen === 'gerrie' || S.screen === 'facturen') renderView(false);
  renderPanel(); updateCounts();
  if (S.notes) requestAnimationFrame(placeNotes);
}

/* ── Meldingen ── */
function toast(msg, o = {}) {
  const box = $('#toasts'); if (!box) return;
  const el = document.createElement('div'); el.className = 'toast'; el.setAttribute('role', 'status');
  let left = o.delay || 0, timer = 0;
  const label = () => left ? `${o.pending || msg} <span class="tm">· gaat over ${left} s de deur uit</span>` : msg;
  el.innerHTML = `${ic(o.icon || 'check', o.iconCls || '')}<span class="msg">${label()}</span>${o.undo ? '<button type="button">Ongedaan maken</button>' : ''}`;
  box.appendChild(el);
  const bye = () => { clearInterval(timer); el.classList.add('bye'); setTimeout(() => el.remove(), 240); };
  if (o.undo) el.querySelector('button').addEventListener('click', () => { o.undo(); bye(); });
  if (left) timer = setInterval(() => { left--; el.querySelector('.msg').innerHTML = label(); if (!left) { clearInterval(timer); el.querySelector('button')?.remove(); setTimeout(bye, 2600); } }, 1000);
  else setTimeout(bye, o.undo ? 6000 : 3200);
  while (box.children.length > 3) box.firstChild.remove();
}
const nyi = what => toast(`${what || 'Dit'} is in het prototype niet uitgewerkt`, { icon: 'info' });

/* ══ Vraagbalk ══ */
const CL_KW = [['bloem', 'bloem'], ['karim', 'bloem'], ['korenaar', 'korenaar'], ['bakkerij', 'korenaar'], ['joost', 'korenaar'], ['fysio', 'fysio'], ['maria', 'fysio'], ['dijk', 'vandijk'], ['peter', 'vandijk'], ['zonnetje', 'zonnetje'], ['els', 'zonnetje'], ['hendriks', 'hendriks']];
const DAYOFF = { vandaag: 0, morgen: 1, overmorgen: 2, vrijdag: 1, zaterdag: 2, zondag: 3, maandag: 4, dinsdag: 5, woensdag: 6, donderdag: 7 };
const dayLabel = off => { const dt = new Date(DEMO.y, DEMO.m, DEMO.d + off); return `${WEEKDAYS[dt.getDay()]} ${dt.getDate()} ${MONTHS[dt.getMonth()].slice(0, 3)}`; };
const CMD_SUGGEST = ['factuur bloem content oktober 650', 'taak drukproef controleren vrijdag', 'afspraak joost dinsdag 14:00', 'uren 2u logo-schetsen', 'wat staat er open bij restaurant bloem?', 'plan mijn vrijdag rond de fotoshoot'];
const PROJ_KW = [['drukproef', 'huisstijl'], ['logo', 'huisstijl'], ['huisstijl', 'huisstijl'], ['menukaart', 'menukaart'], ['website', 'fysioweb'], ['mailing', 'winter'], ['winter', 'winter'], ['offerte', 'zonnetje']];

function parse(q) {
  const s = q.toLowerCase().replace(/\s+/g, ' ').trim();
  if (s.length < 3) return null;
  if (/\?\s*$/.test(s) || /^(wat|wie|hoeveel|wanneer|welke|hoe|waar|plan mijn|geef|toon)\b/.test(s)) return { kind: 'vraag', s };
  const m = s.match(/^(factuur|factureer|offerte|taak|todo|afspraak|overleg|uren|boek)\b\s*(.*)$/);
  if (!m) return null;
  const kind = { factureer: 'factuur', todo: 'taak', overleg: 'afspraak', boek: 'uren' }[m[1]] || m[1];
  let rest = ` ${m[2]} `; const o = { kind };
  for (const [k, c] of CL_KW) { const re = new RegExp(`\\s(voor |bij |met |aan )?(restaurant |bakkerij |de |van |kinderopvang )?${k}[a-z]*`); if (re.test(rest)) { o.client = c; rest = rest.replace(re, ' '); break; } }
  const tm = rest.match(/\s(?:om )?(\d{1,2})[:.](\d{2})\b/) || rest.match(/\som (\d{1,2})(?:\s?uur)?\b/);
  if (tm) { o.time = +tm[1] * 60 + (+tm[2] || 0); rest = rest.replace(tm[0], ' '); }
  const dm = rest.match(/\s(vandaag|morgen|overmorgen|maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag|zondag)\b/);
  if (dm) { o.day = DAYOFF[dm[1]]; rest = rest.replace(dm[0], ' '); }
  if (kind === 'uren') { const um = rest.match(/\s(\d+(?:[.,]\d+)?)\s?(u|uur|h)\b/) || rest.match(/\s(\d+)\s?(min|m)\b/); if (um) { o.mins = /m/.test(um[2]) ? +um[1] : Math.round(parseFloat(um[1].replace(',', '.')) * 60); rest = rest.replace(um[0], ' '); } }
  if (kind === 'factuur' || kind === 'offerte') { const am = rest.match(/\s(?:€\s?)?(\d{2,6}(?:[.,]\d{1,2})?)(?:\s?(?:euro|eur))?(?=\s)/); if (am) { o.amount = parseFloat(am[1].replace(',', '.')); rest = rest.replace(am[0], ' '); } }
  const desc = rest.replace(/\s(voor|bij|met|een|de|het|om|op|aan|rond)(?=\s)/g, ' ').replace(/\s+/g, ' ').trim();
  if (desc) o.desc = desc[0].toUpperCase() + desc.slice(1);
  if (!o.client) for (const [k, p] of PROJ_KW) if ((o.desc || '').toLowerCase().includes(k)) { o.project = p; break; }
  if (o.client && !o.project) o.project = Object.keys(PROJECTS).find(k => PROJECTS[k].client === o.client);
  return o;
}
function tok(icon, label, val, delay) { return `<span class="tok" style="animation-delay:${delay * 40}ms">${ic(icon)}${label ? `<span>${label}</span>` : ''}${val}</span>`; }
function intentHtml(o) {
  if (!o || o.kind === 'vraag') return '';
  const cl = o.client ? CLIENTS[o.client] : null;
  const K = { factuur: ['receipt', 'Factuur'], offerte: ['file-text', 'Offerte'], taak: ['list-todo', 'Taak'], afspraak: ['calendar-clock', 'Afspraak'], uren: ['timer', 'Uren'] }[o.kind];
  const toks = [tok(K[0], '', K[1], 0)];
  if (cl) toks.push(tok('users', '', cl.name, 1));
  if (o.desc) toks.push(tok('type', '', o.desc, 2));
  if (o.amount) toks.push(tok('euro', '', eurTxt(o.amount) + ' excl. btw', 3));
  if (o.day != null) toks.push(tok('calendar', '', dayLabel(o.day), 4));
  if (o.time != null) toks.push(tok('clock', '', hm(o.time), 5));
  if (o.mins) toks.push(tok('timer', '', dur(o.mins), 5));
  if (o.project && o.kind !== 'factuur') toks.push(tok('folder-kanban', '', PROJECTS[o.project].name, 6));
  let grid = '', title = '', ready = false, note = 'Komt als concept klaar te staan. Er wordt niets verstuurd.';
  if (o.kind === 'factuur' || o.kind === 'offerte') {
    ready = !!(cl && o.amount);
    title = `${K[1]} ${o.kind === 'factuur' ? '2026-043' : '2026-022'} · concept`;
    grid = `<div><span>Klant</span><b>${cl ? cl.name : '<span style="color:var(--ink-3)">Welke klant?</span>'}</b></div><div><span>Omschrijving</span><b>${o.desc || 'Werkzaamheden'}</b></div><div><span>Totaal incl. 21% btw</span><b>${o.amount ? eur(o.amount * 1.21) : '<span style="color:var(--ink-3)">Welk bedrag?</span>'}</b></div>`;
    if (o.kind === 'factuur') note = 'Vervalt 5 november (14 dagen). Komt als concept in Facturen; er wordt niets verstuurd.';
  } else if (o.kind === 'taak') {
    ready = !!o.desc; title = 'Nieuwe taak';
    grid = `<div><span>Taak</span><b>${o.desc || '<span style="color:var(--ink-3)">Wat moet er gebeuren?</span>'}</b></div><div><span>Project</span><b>${o.project ? PROJECTS[o.project].name : 'Geen project'}</b></div><div><span>Wanneer</span><b>${o.day != null ? dayLabel(o.day) : 'Deze week'}</b></div>`;
    note = 'Komt in je weekplanner en op het projectbord.';
  } else if (o.kind === 'afspraak') {
    ready = !!(cl && o.day != null); title = 'Nieuwe afspraak';
    grid = `<div><span>Met</span><b>${cl ? cl.contact : '<span style="color:var(--ink-3)">Met wie?</span>'}</b></div><div><span>Wanneer</span><b>${o.day != null ? dayLabel(o.day) : '?'}${o.time != null ? ' · ' + hm(o.time) + ' – ' + hm(o.time + 60) : ''}</b></div><div><span>Waar</span><b>Video via Jitsi</b></div>`;
    note = 'Je ziet eerst de uitnodiging; versturen doe jij.';
  } else if (o.kind === 'uren') {
    ready = !!o.mins; title = 'Uren boeken';
    grid = `<div><span>Duur</span><b>${o.mins ? dur(o.mins) : '?'}</b></div><div><span>Op</span><b>${o.project ? PROJECTS[o.project].name : (o.desc || '?')}</b></div><div><span>Datum</span><b>${o.day != null ? dayLabel(o.day) : 'vandaag'}</b></div>`;
    note = 'Declarabel tegen € 85 per uur.';
  }
  return `<div class="ck-parse"><span class="lbl"><span class="orb sm"></span>Gerrie begrijpt</span>${toks.join('')}</div>
  <div class="ck-prev" id="ckprev"><div class="ck-prev-h">${ic(K[0])}<b>${title}</b><span class="pill ${ready ? 'ok' : 'warn'}">${ready ? 'Compleet' : 'Nog iets nodig'}</span></div><div class="ck-prev-b">${grid}</div>
  <div class="ck-prev-f"><span class="note">${ic('shield-check')}${note}</span><button class="btn btn-gold btn-sm ck-it-btn" data-ckrun="intent" ${ready ? '' : 'disabled style="opacity:.5;pointer-events:none"'}>Klaarzetten<kbd style="margin-left:4px;height:18px;min-width:18px;background:rgba(0,0,0,.12);border-color:rgba(0,0,0,.2);color:inherit">↵</kbd></button></div></div>`;
}
function answer(s) {
  if (/bloem|karim/.test(s)) return { h: 'Bij <b>Restaurant Bloem</b> staat één factuur open: <b>2026-040</b> (€ 786,50), al 10 dagen te laat. Er loopt een ticket over de prijswijziging van de menukaart, en de menukaart zelf moet vandaag drukklaar.', a: [['bell-ring', 'Herinnering bekijken', 'dec:d1'], ['receipt', 'Factuur openen', 'peek:2026-040']] };
  if (/vrijdag|plan/.test(s)) return { h: 'Vrijdag staat de <b>fotoshoot bij Restaurant Bloem</b> van 09:00 tot 12:00, en om 15:00 de weekafsluiting. Daartussen heb je twee uur vrij: een goed moment voor het <b>huisstijlhandboek</b> van De Korenaar (deadline 6 november).', a: [['calendar-clock', 'Focusblok inplannen', 'go:agenda']] };
  if (/open|openstaand|betaal|geld/.test(s)) return { h: 'Er staat <b>€ 3.690,50</b> open in twee facturen: 2026-041 van De Korenaar (vervalt 28 oktober) en 2026-040 van Restaurant Bloem (10 dagen te laat).', a: [['receipt', 'Naar facturen', 'go:facturen']] };
  return { h: 'In dit prototype beantwoordt Gerrie een paar vragen. Probeer <b>Wat staat er nog open bij Restaurant Bloem?</b>', a: [] };
}
function search(q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return INDEX.filter(x => { const hay = (x.t + ' ' + (x.sub || '') + ' ' + x.kw).toLowerCase(); return words.every(w => hay.includes(w)); }).slice(0, 6);
}
const mark = (t, q) => { const w = q.trim().split(/\s+/)[0]; if (!w) return t; const i = t.toLowerCase().indexOf(w.toLowerCase()); return i < 0 ? t : t.slice(0, i) + '<mark>' + t.slice(i, i + w.length) + '</mark>' + t.slice(i + w.length); };
let ckStream = 0;
function ckRender() {
  const input = $('#ckq'); const q = input ? input.value : '';
  const o = parse(q), body = $('#ckbody');
  const ghost = q && CMD_SUGGEST.find(sg => sg.startsWith(q.toLowerCase()) && sg.length > q.length);
  $('#ckghost').innerHTML = ghost ? `<span>${q.replace(/</g, '&lt;')}</span><em>${ghost.slice(q.length)}</em>` : '';
  $('#cktab').hidden = !ghost;
  clearInterval(ckStream);
  let html = '';
  if (!q.trim()) {
    html = `<div class="ck-sec">${ic('sparkles', 'i-sm i-ai')}Vraag Gerrie</div>${ASK.map((a, i) => `<button class="ck-it" data-ckfill="${a}"><span class="ic ai">${ic(i === 2 ? 'wand-sparkles' : 'sparkles')}</span><span class="t">${a}</span><span class="k"></span></button>`).join('')}
    <div class="ck-sec">Recent</div>${[INDEX[0], INDEX[5], INDEX[8]].map(x => `<button class="ck-it" data-ckgo="${INDEX.indexOf(x)}"><span class="ic">${ic(x.ic)}</span><span class="t">${x.t}<small>${x.sub}</small></span><span class="k">${x.g.replace(/en$/, '')}</span></button>`).join('')}
    <div class="ck-sec">Maak</div>${INDEX.filter(x => x.fill).map(x => `<button class="ck-it" data-ckgo="${INDEX.indexOf(x)}"><span class="ic">${ic(x.ic)}</span><span class="t">${x.t}</span><span class="k"><kbd>${x.key}</kbd></span></button>`).join('')}`;
  } else if (o && o.kind === 'vraag') {
    const an = answer(o.s);
    html = `<div class="ck-sec">${ic('sparkles', 'i-sm i-ai')}Gerrie</div><div class="ck-ans" id="ckans"></div><div id="ckacts" style="display:flex;gap:8px;padding:8px 16px 12px;flex-wrap:wrap" hidden>${an.a.map(([i, l, r]) => `<button class="btn btn-ai btn-sm ck-it" style="width:auto;min-height:0" data-ckact="${r}">${ic(i)}${l}</button>`).join('')}</div>`;
    body.innerHTML = html; streamAnswer(an.h); return;
  } else {
    const res = search(q);
    html = intentHtml(o) + (res.length ? `<div class="ck-sec">${o ? 'Of ga naar' : 'Resultaten'}</div>` + res.map(x => `<button class="ck-it" data-ckgo="${INDEX.indexOf(x)}"><span class="ic">${ic(x.ic)}</span><span class="t">${mark(x.t, q)}${x.sub ? `<small>${x.sub}</small>` : ''}</span><span class="k">${x.g}</span></button>`).join('') : '')
      + (!o && !res.length ? `<div class="ck-sec">${ic('sparkles', 'i-sm i-ai')}Niets gevonden</div><button class="ck-it" data-ckfill="${q.replace(/"/g, '')}?"><span class="ic ai">${ic('sparkles')}</span><span class="t">Vraag Gerrie: “${q.replace(/</g, '&lt;')}”</span><span class="k"></span></button>` : '');
  }
  body.innerHTML = html;
  S.ck.idx = 0; ckMark();
}
function streamAnswer(h) {
  const box = $('#ckans'); const parts = h.match(/<[^>]+>|[^<\s]+|\s+/g) || [];
  let i = 0, out = '';
  if (reduced()) { box.innerHTML = h; $('#ckacts').hidden = false; return; }
  ckStream = setInterval(() => {
    for (let n = 0; n < 2 && i < parts.length; n++) out += parts[i++];
    box.innerHTML = out + (i < parts.length ? '<span class="caret"></span>' : '');
    if (i >= parts.length) { clearInterval(ckStream); $('#ckacts').hidden = false; }
  }, 38);
}
function ckItems() { return $$('#ckbody .ck-it, #ckbody [data-ckrun]'); }
function ckMark() { const it = ckItems(); it.forEach((el, i) => el.classList.toggle('is-on', i === S.ck.idx)); }
function openCk(fill) {
  const ck = $('#cmdk');
  ck.innerHTML = `<div class="ck" role="dialog" aria-modal="true" aria-label="Vraagbalk"><div class="ck-in"><span class="orb live"></span><div class="ck-field"><div class="ck-ghost" id="ckghost" aria-hidden="true"></div><input id="ckq" autocomplete="off" spellcheck="false" placeholder="Vraag Gerrie, zoek of maak iets…" aria-label="Vraag, zoek of maak iets"></div><span class="ck-tab" id="cktab" hidden><kbd>Tab</kbd>aanvullen</span><kbd>esc</kbd></div><div class="ck-body" id="ckbody"></div>
    <div class="ck-foot"><span><kbd>↑</kbd><kbd>↓</kbd>kiezen</span><span><kbd>↵</kbd>doen</span><span class="sp"></span><span>${ic('shield-check', 'i-sm')}Gerrie zet klaar, jij beslist</span></div></div>`;
  ck.hidden = false; S.ck.open = true;
  const input = $('#ckq');
  input.value = fill || '';
  input.addEventListener('input', ckRender);
  input.addEventListener('keydown', ckKeys);
  ckRender();
  setTimeout(() => input.focus({ preventScroll: true }), 30);
}
function closeCk() { const ck = $('#cmdk'); if (!ck || ck.hidden) return; clearInterval(ckStream); clearTimeout(demoT); ck.hidden = true; S.ck.open = false; ck.innerHTML = ''; }
function ckKeys(e) {
  const it = ckItems();
  if (e.key === 'ArrowDown') { S.ck.idx = (S.ck.idx + 1) % Math.max(1, it.length); ckMark(); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { S.ck.idx = (S.ck.idx - 1 + it.length) % Math.max(1, it.length); ckMark(); e.preventDefault(); }
  else if (e.key === 'Enter') { const el = it[S.ck.idx]; if (el) el.click(); e.preventDefault(); }
  else if (e.key === 'Tab') { const g = $('#ckghost em'); if (g) { e.target.value += g.textContent; ckRender(); e.preventDefault(); } }
  else if (e.key === 'Escape') { closeCk(); e.preventDefault(); e.stopPropagation(); }
}
function ckRun(el) {
  if (el.dataset.ckfill != null) { const i = $('#ckq'); i.value = el.dataset.ckfill; ckRender(); i.focus(); return; }
  if (el.dataset.ckgo != null) { const x = INDEX[+el.dataset.ckgo]; if (x.fill) { const i = $('#ckq'); i.value = x.fill; ckRender(); i.focus(); return; } closeCk(); if (x.peek) { go('facturen'); setTimeout(() => openPeek(x.peek), 60); } else if (x.go) go(x.go); else nyi(x.t); return; }
  if (el.dataset.ckact) { const [k, v] = el.dataset.ckact.split(':'); closeCk(); if (k === 'go') go(v); if (k === 'peek') { go('facturen'); setTimeout(() => openPeek(v), 60); } if (k === 'dec') { S.gsel = v; go('gerrie'); } return; }
  if (el.dataset.ckrun === 'intent') {
    const o = parse($('#ckq').value); closeCk();
    const msg = { factuur: `Factuur 2026-043 voor ${o.client ? CLIENTS[o.client].short : ''} staat als concept klaar`, offerte: 'Offerte 2026-022 staat als concept klaar', taak: `Taak “${o.desc}” toegevoegd`, afspraak: `Uitnodiging voor ${o.client ? CLIENTS[o.client].contact : ''} staat klaar`, uren: `${dur(o.mins)} geboekt` }[o.kind];
    toast(msg, { icon: 'circle-check', iconCls: 'ok', undo: () => {} });
  }
}
let demoT = 0;
function demoType(text) {
  if (!S.ck.open) openCk('');
  const input = $('#ckq'); input.value = ''; ckRender();
  let i = 0; clearTimeout(demoT);
  const tick = () => { if (!S.ck.open) return; input.value = text.slice(0, ++i); ckRender(); if (i < text.length) demoT = setTimeout(tick, reduced() ? 0 : 55 + Math.random() * 45); else { const prev = $('#ckprev'); prev && prev.animate && !reduced() && prev.animate([{ boxShadow: '0 0 0 0 rgba(247,197,72,.0)' }, { boxShadow: '0 0 0 4px rgba(247,197,72,.35)' }, { boxShadow: '0 0 0 0 rgba(247,197,72,0)' }], { duration: 900 }); } };
  demoT = setTimeout(tick, 350);
}

/* ══ Weergave-popover ══ */
let setMode = () => {}, getMode = () => 'auto';
function renderPop() {
  const m = getMode();
  const th = (k, l, s, sw) => `<button class="th" aria-pressed="${m === k}" data-mode="${k}"><span class="th-sw ${sw}"></span>${l}<small>${s}</small></button>`;
  $('#pop').innerHTML = `<div class="pop-h">Weergave</div><div class="pop-themes">${th('dag', 'Dag', 'Licht, papier op steen', 'dag')}${th('nacht', 'Nacht', 'Grafiet met één lamp', 'nacht')}${th('zon', 'Met de zon mee', `Dag van ${hm(SUN.rise)} tot ${hm(SUN.set)}`, 'zon')}${th('auto', 'Systeem', 'Volgt je apparaat', 'sys')}</div>
  <div class="pop-sep"></div>
  <div class="pop-row"><span>Dichtheid</span><div class="seg"><button aria-pressed="${S.density === 'ruim'}" data-density="ruim">Ruim</button><button aria-pressed="${S.density === 'compact'}" data-density="compact">Compact</button></div></div>
  <div class="pop-row"><span>Sneltoetsen</span><span style="color:var(--ink-3);font-size:12px"><kbd>⌘K</kbd> <kbd>/</kbd> <kbd>G</kbd> + letter</span></div>`;
}
function togglePop(show) {
  const p = $('#pop'); const on = show ?? p.hidden;
  if (on) { renderPop(); p.hidden = false; } else p.hidden = true;
}

/* ══ Ontwerpnotities ══ */
const NOTES = {
  vandaag: [
    ['.rail', 'Nachtrail', 'Zeven modules in één donkere rail, in Dag én in Nacht: het merkanker. Waar je bent gloeit zongoud; Gerrie draagt altijd het poollicht.', 'tr'],
    ['.panel .pnav', 'Contextpaneel', 'Wat je in deze module kunt, plus vastgezette klanten en projecten. Financiën had vijftien regels in één uitklapmenu; nu krijgt elke module haar eigen paneel en blijft het menu kort.', 'tr'],
    ['.ask', 'Vraagbalk', 'Eén plek om te zoeken, te springen, iets te maken of Gerrie iets te vragen, in gewone taal. Altijd bereikbaar met ⌘K of /.', 'tl'],
    ['#sun', 'Dagboog', 'Je dag als horizon: afspraken en focusblokken op de baan van de zon boven Lopik. Sleep de zon of speel de dag af; het hele scherm beweegt mee.', 'tr'],
    ['#nn', 'Nu en volgende', 'Altijd zichtbaar wat er nú speelt en wat er hierna komt, met precies de knop die je dan nodig hebt: deelnemen, route of bellen.', 'tl'],
    ['#decide .card-h', 'Te beslissen', 'Wat Gerrie en je agents klaarzetten, mét het waarom. Akkoord geven kan met één klik; niets gaat de deur uit zonder jou.', 'tl'],
    ['.puls', 'Puls', 'Vier cijfers in één kaart, elk met context: een trend, een verdeling of een doel. Bedragen staan altijd voluit, de centen een tikje kleiner.', 'tl'],
    ['#tasks .card-h', 'Vandaag te doen', 'Afvinken met één klik, ordenen door te slepen. Wat blijft liggen staat bovenaan in rood.', 'tl'],
    ['.flow .flow-top', 'Geldstroom', 'Het saldo nu en wat Gerrie verwacht voor de komende dertig dagen, met een eerlijke bandbreedte in plaats van één stellig getal.', 'tl'],
  ],
  klant: [
    ['.khero', 'Klant in één oogopslag', 'De kop draagt de kleur van de klant. Vier cijfers vertellen het verhaal: wat de relatie waard is, wat er openstaat, wat er loopt en hoe warm het contact is.', 'tl'],
    ['.subtabs', 'Rustige tabbladen', 'Eén gouden streep onder waar je bent. Tellers geven alvast een idee van wat erachter zit.', 'tl'],
    ['.tl', 'Tijdlijn', 'Mail, chat, agenda, offertes en facturen op één lijn. Wat Joost zei staat erbij, zodat iedereen in het team bij is.', 'tl'],
    ['.ai-card', 'Gerrie over deze klant', 'Een korte samenvatting van wat ertoe doet, met de volgende stap als knop. Herkenbaar aan het poollicht.', 'tl'],
  ],
  project: [
    ['.meters', 'Voortgang tegen de tijd', 'Werk en tijd in één balk: je ziet meteen of een project achterloopt. Gerrie stelt voor wat je kunt schuiven.', 'tl'],
    ['.kc.ghost', 'Spookkaart', 'Gerrie haalt actiepunten uit de teamchat en zet ze als voorstel op het bord. Toevoegen of wegklikken, meer niet.', 'tr'],
    ['#board', 'Slepen', 'Kaarten verplaats je met de muis of het toetsenbord. Een kolom licht goud op waar de kaart landt.', 'tr'],
  ],
  facturen: [
    ['.sumrow', 'Samenvatting eerst', 'Vier bedragen voordat je in de lijst duikt. Te laat staat in rood, met een icoon, zodat het niet alleen op kleur leunt.', 'tl'],
    ['.banner', 'Gerrie in context', 'Een voorstel verschijnt waar je het nodig hebt, niet in een aparte inbox. Akkoord kan hier direct.', 'tl'],
    ['#invtable', 'Spiekpaneel', 'Klik op een factuur en hij opent ernaast, als papier. Je raakt je plek in de lijst niet kwijt; selecteer meerdere voor een actie op allemaal.', 'tr'],
  ],
  agenda: [
    ['.week', 'Week als werkblad', 'Afspraken vol, focusblokken gestreept. De lijn van nu in zongoud.', 'tl'],
    ['.we.ai', 'Voorstel in je agenda', 'Gerrie vindt vrije tijd en stelt voor wat erin past. Gestippeld in het poollicht tot jij het inplant.', 'tl'],
  ],
  gerrie: [
    ['.q', 'Wachtrij', 'Alles wat op jou wacht, en daaronder wat er bij je team ligt. Je beslist over je eigen agents; collega’s over de hunne.', 'tr'],
    ['.dcard .dfacts', 'Waarom nu', 'Elk voorstel komt met de feiten waarop het rust. Geen zwarte doos.', 'tl'],
    ['.dcard .dact', 'Beslissen met je toetsenbord', 'A voor akkoord, L voor later, N voor niet meer. Mails gaan pas na tien seconden de deur uit, zodat je het nog kunt terugdraaien.', 'tl'],
    ['.agents', 'Je agents', 'Wie er voor je werkt, wanneer, en wat het oplevert. Goud als hij draait.', 'tl'],
  ],
};
let onNote = () => {};
function placeNotes() {
  $$('.nd').forEach(n => n.remove());
  if (!S.notes) return;
  const app = $('#app'), ar = app.getBoundingClientRect(), vr = $('#view').getBoundingClientRect(), list = NOTES[S.screen] || [];
  list.forEach(([sel, t, d, pos], i) => {
    const el = $(sel, app); if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width === 0) return;
    // Wat in het werkvlak buiten beeld is geschoven, krijgt (nog) geen stip.
    if ($('#view').contains(el) && (r.bottom < vr.top + 8 || r.top > vr.bottom - 8)) return;
    let x = (pos[1] === 'r' ? r.right - ar.left : r.left - ar.left) / appScale, y = (r.top - ar.top) / appScale;
    x = Math.max(16, Math.min(1424, x)); y = Math.max(16, Math.min(884, y));
    const b = document.createElement('button');
    b.className = 'nd' + (i === S.note ? ' is-on' : ''); b.textContent = i + 1; b.style.left = x + 'px'; b.style.top = y + 'px';
    b.setAttribute('aria-label', `Ontwerpnotitie ${i + 1}: ${t}`);
    b.addEventListener('click', e => { e.stopPropagation(); S.note = i; placeNotes(); });
    app.appendChild(b);
  });
  onNote(list[S.note] ? { i: S.note, n: list.length, t: list[S.note][1], d: list[S.note][2] } : null);
}
/* De gekozen notitie in beeld schuiven, binnen het werkvlak. */
function showNote(i) {
  const list = NOTES[S.screen] || []; if (!list.length) return;
  S.note = (i + list.length) % list.length;
  const el = $(list[S.note][0], $('#app')), view = $('#view');
  if (el && view.contains(el)) {
    const r = el.getBoundingClientRect(), vr = view.getBoundingClientRect();
    if (r.top < vr.top + 40 || r.bottom > vr.bottom - 40) view.scrollTo({ top: Math.max(0, view.scrollTop + (r.top - vr.top) / appScale - 60), behavior: reduced() ? 'auto' : 'smooth' });
  }
  placeNotes();
}
let noteRaf = 0;
function watchViewScroll() { $('#view').addEventListener('scroll', () => { if (!S.notes) return; cancelAnimationFrame(noteRaf); noteRaf = requestAnimationFrame(placeNotes); }, { passive: true }); }

/* ══ Kaarten slepen (bord) en taken ordenen ══ */
function mountDnD() {
  const app = $('#app');
  let dragKc = null, dragTask = null;
  app.addEventListener('dragstart', e => {
    const kc = e.target.closest?.('.kc:not(.ghost)'); const tk = e.target.closest?.('.task');
    if (kc) { dragKc = kc.dataset.kc; kc.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragKc); }
    else if (tk) { dragTask = tk.dataset.task; tk.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragTask); }
  });
  app.addEventListener('dragend', () => { $$('.dragging').forEach(x => x.classList.remove('dragging')); $$('.lane.over').forEach(x => x.classList.remove('over')); $$('.drop-above').forEach(x => x.classList.remove('drop-above')); dragKc = dragTask = null; });
  app.addEventListener('dragover', e => {
    if (dragKc) { const lane = e.target.closest('.lane'); if (lane) { e.preventDefault(); $$('.lane.over').forEach(x => x !== lane && x.classList.remove('over')); lane.classList.add('over'); } }
    if (dragTask) { const row = e.target.closest('.task'); if (row && row.dataset.task !== dragTask) { e.preventDefault(); $$('.drop-above').forEach(x => x.classList.remove('drop-above')); row.classList.add('drop-above'); } }
  });
  app.addEventListener('drop', e => {
    if (dragKc) {
      const lane = e.target.closest('.lane'); if (!lane) return; e.preventDefault();
      const to = lane.dataset.lane; let card, from;
      for (const [k] of LANES) { const i = S.board[k].findIndex(c => c.id === dragKc); if (i >= 0) { card = S.board[k].splice(i, 1)[0]; from = k; } }
      S.board[to].push(card); renderView(false);
      if (from !== to) toast(`“${card.t}” staat nu bij ${LANES.find(l => l[0] === to)[1]}`, { icon: 'arrow-right', undo: () => { S.board[to] = S.board[to].filter(c => c !== card); S.board[from].push(card); renderView(false); } });
    }
    if (dragTask) {
      const row = e.target.closest('.task'); if (!row) return; e.preventDefault();
      const a = S.tasks.findIndex(t => t.id === dragTask); const moved = S.tasks.splice(a, 1)[0];
      const b = S.tasks.findIndex(t => t.id === row.dataset.task); moved.group = S.tasks[b].group; S.tasks.splice(b, 0, moved);
      $('#tasks').innerHTML = tasksCard();
    }
  });
}

/* ══ Klikken ══ */
function onAppClick(e) {
  const t = e.target.closest('button, [data-go], [data-tab], tr[data-inv], .ev, [data-kc]');
  const pop = $('#pop');
  if (pop && !pop.hidden && !e.target.closest('#pop') && !e.target.closest('[data-act="weergave"]')) togglePop(false);
  if (!t) return;
  const d = t.dataset;
  if (e.target.closest('#cmdk')) { if (t.closest('#ckbody') || d.ckrun) { ckRun(t); } return; }
  if (d.close) { e.stopPropagation(); const i = S.tabs.findIndex(x => x.id === +d.close); S.tabs.splice(i, 1); if (S.tab === +d.close) { S.tab = S.tabs[Math.max(0, i - 1)].id; S.screen = S.tabs.find(x => x.id === S.tab).screen; renderPanel(); renderRail(); renderView(); onScreen(S.screen); } renderTabs(); return; }
  if (d.tab) { const tb = S.tabs.find(x => x.id === +d.tab); S.tab = tb.id; S.screen = tb.screen; closePeek(true); renderTabs(); renderPanel(); renderRail(); renderView(); onScreen(S.screen); return; }
  if (d.mod) { go(MOD_HOME[d.mod]); return; }
  if (d.go) { go(d.go); return; }
  if (d.mode) { setMode(d.mode, t); renderPop(); return; }
  if (d.density) { S.density = d.density; $('#app').classList.toggle('compact', d.density === 'compact'); renderPop(); if (S.notes) requestAnimationFrame(placeNotes); return; }
  if (d.check) { const tk = S.tasks.find(x => x.id === d.check); tk.done = !tk.done; const row = t.closest('.task'); row.classList.toggle('done', tk.done); t.setAttribute('aria-checked', tk.done); row.querySelector('.when').textContent = tk.done ? 'Klaar' : tk.when; row.querySelector('.when').className = 'when ' + (tk.done ? '' : (tk.cls || '')); const open = S.tasks.filter(x => !x.done); $('#tasksum').textContent = `${open.length} open · ± ${dur(open.reduce((a, x) => a + x.est, 0))} werk`; if (tk.done) toast(`“${tk.t}” afgerond`, { icon: 'circle-check', iconCls: 'ok', undo: () => { tk.done = false; $('#tasks').innerHTML = tasksCard(); } }); return; }
  if (d.approve) { decide(d.approve, 'ok'); return; }
  if (d.later) { decide(d.later, 'later'); return; }
  if (d.mute) { decide(d.mute, 'mute'); return; }
  if (d.opendec) { S.gsel = d.opendec; go('gerrie'); return; }
  if (d.gsel) { S.gsel = d.gsel; renderView(false); return; }
  if (d.evjump != null) { tweenTime(TODAY[+d.evjump].s + 1); return; }
  if (d.invf) { S.inv.f = d.invf; $$('.chipf').forEach(c => c.setAttribute('aria-pressed', c.dataset.invf === d.invf)); $('#invtable').innerHTML = invTable(); if (S.notes) requestAnimationFrame(placeNotes); return; }
  if (d.sel) { e.stopPropagation(); S.inv.sel.has(d.sel) ? S.inv.sel.delete(d.sel) : S.inv.sel.add(d.sel); $('#invtable').innerHTML = invTable(); renderBulk(); return; }
  if (d.inv) { S.peek === d.inv ? closePeek() : openPeek(d.inv); return; }
  if (d.ktab) { S.ktab = d.ktab; $$('[data-ktab]').forEach(b => b.setAttribute('aria-selected', b.dataset.ktab === d.ktab)); if (d.ktab !== 'overzicht' && d.ktab !== 'tijdlijn') nyi('Dit tabblad'); return; }
  switch (d.act) {
    case 'cmdk': openCk(''); break;
    case 'cmdk-new': openCk(''); break;
    case 'cmdk-fill': openCk(d.fill); break;
    case 'weergave': togglePop(); break;
    case 'newtab': S.seq++; S.tabs.push({ id: S.seq, screen: 'vandaag' }); S.tab = S.seq; S.screen = 'vandaag'; renderTabs(); renderPanel(); renderRail(); renderView(); onScreen('vandaag'); break;
    case 'play': play(); break;
    case 'now': tweenTime(DEMO.now); break;
    case 'peek-close': closePeek(); break;
    case 'ghost-yes': S.ghost = false; renderView(false); toast('Subtaak toegevoegd aan “Drukproef briefpapier”', { icon: 'circle-check', iconCls: 'ok', undo: () => { S.ghost = true; renderView(false); } }); break;
    case 'ghost-no': S.ghost = false; renderView(false); toast('Voorstel weggeklikt', { icon: 'x' }); break;
    case 'ai-slot': S.aiSlot = false; WEEK.push({ d: 4, s: 780, e: 900, t: 'Huisstijlhandboek opzetten', w: 'Focus', c: '#FFD966', focus: true }); renderView(false); toast('Focusblok ingepland op vrijdag 13:00', { icon: 'calendar-clock' }); break;
    case 'reset-dec': S.decisions = DECISIONS.map(x => x.id); S.gsel = 'd1'; refreshDecisions(); break;
    case 'bulk-clear': S.inv.sel.clear(); $('#invtable').innerHTML = invTable(); renderBulk(); break;
    case 'bulk-remind': toast(`${S.inv.sel.size} herinnering${S.inv.sel.size === 1 ? '' : 'en'} klaargezet bij Te beslissen`, { icon: 'sparkles' }); S.inv.sel.clear(); $('#invtable').innerHTML = invTable(); renderBulk(); break;
    case 'bulk-paid': case 'bulk-pdf': nyi(d.act === 'bulk-paid' ? 'Markeren als betaald' : 'Pdf’s downloaden'); break;
    case 'nyi': nyi(d.what); break;
  }
}

/* ══ Toetsenbord ══ */
let gChord = 0;
function appKeys(e) {
  const typing = /input|textarea/i.test(document.activeElement?.tagName || '');
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); S.ck.open ? closeCk() : openCk(''); return true; }
  if (S.ck.open) return false;
  if (e.key === 'Escape') { if (!$('#pop').hidden) togglePop(false); else if (S.peek) closePeek(); return false; }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return false;
  if (e.key === '/') { e.preventDefault(); openCk(''); return true; }
  if (gChord && Date.now() - gChord < 900) { const m = { v: 'vandaag', g: 'gerrie', a: 'agenda', w: 'klant', f: 'facturen', p: 'project' }[e.key.toLowerCase()]; gChord = 0; if (m) { go(m); return true; } }
  if (e.key.toLowerCase() === 'g') { gChord = Date.now(); return true; }
  if (S.screen === 'gerrie' && S.decisions.length) {
    const k = e.key.toLowerCase();
    if (k === 'a' || e.key === 'Enter') { decide(S.gsel, 'ok'); return true; }
    if (k === 'l') { decide(S.gsel, 'later'); return true; }
    if (k === 'n') { decide(S.gsel, 'mute'); return true; }
    if (k === 'e') { nyi('Aanpassen in de editor'); return true; }
    if (k === 'j' || e.key === 'ArrowDown' || k === 'k' || e.key === 'ArrowUp') { const i = S.decisions.indexOf(S.gsel), dlt = (k === 'j' || e.key === 'ArrowDown') ? 1 : -1; S.gsel = S.decisions[(i + dlt + S.decisions.length) % S.decisions.length]; renderView(false); e.preventDefault(); return true; }
  }
  return false;
}

function mountApp(root) {
  root.innerHTML = shell();
  renderTabs(); renderPanel(); renderRail(); renderView(false);
  root.addEventListener('click', onAppClick);
  watchViewScroll();
  $('#cmdk').addEventListener('mousedown', e => { if (e.target.id === 'cmdk') closeCk(); });
  mountDnD();
}
