/* ══ De voorstelpagina ══════════════════════════════════════════════════════
   Thema's (Nacht, Dag, Systeem en in het prototype ook Met de zon mee), het
   prototype zelf, de demo's, de drie telefoons en de contrastberekening. */
const THEME_KEY = 'resofly.stroom.thema';
const QS = new URLSearchParams(location.search);
const APPS = [];
const LIGHTS = [];
const STREAMS = [];
// Volgorde: een eigen keuze op deze pagina, anders de keuze van de kijker (data-theme), anders het systeem
const hostTheme = document.documentElement.dataset.theme;
let themeMode = hostTheme === 'dark' || hostTheme === 'light' ? hostTheme : 'system';
try { themeMode = localStorage.getItem(THEME_KEY) || themeMode; } catch (e) { /* geen opslag: zoals de kijker */ }
if (QS.get('thema')) themeMode = QS.get('thema');

const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
function resolveTheme(mode) {
  if (mode === 'sun') { const s = sunTimes(new Date()); const m = nowMin(); return m >= s.rise && m < s.set ? 'light' : 'dark'; }
  return mode === 'system' ? null : mode;
}
function applyTheme(mode, instant, keep = true) {
  themeMode = mode;
  const t = resolveTheme(mode);
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  document.querySelectorAll('[data-set-theme]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.setTheme === mode)));
  if (keep) { try { localStorage.setItem(THEME_KEY, mode); } catch (e) { /* niet bewaard, wel gewisseld */ } }
  APPS.forEach(a => a.retheme(instant));
  LIGHTS.forEach(l => l.retheme(instant));
  STREAMS.forEach(s => s.retheme());
}
window.STROOM_THEME = () => themeMode;
// Het nieuwe licht komt op vanuit waar je klikte (of de zon), als een cirkel
window.STROOM_SET_THEME = (mode, from) => {
  if (mode === themeMode) return;
  const before = document.documentElement.dataset.theme || '';
  const r = from && from.getBoundingClientRect ? from.getBoundingClientRect() : null;
  document.documentElement.style.setProperty('--vx', r ? (r.left + r.width / 2) + 'px' : '50%');
  document.documentElement.style.setProperty('--vy', r ? (r.top + r.height / 2) + 'px' : '0px');
  const go = () => applyTheme(mode, true);
  const changes = (resolveTheme(mode) || '') !== before;
  if (document.startViewTransition && !reducedMotion() && changes) {
    document.documentElement.classList.add('vt-theme');
    const t = document.startViewTransition(go);
    t.finished.finally(() => document.documentElement.classList.remove('vt-theme'));
  } else go();
};
applyTheme(themeMode, true, false);
// Systeem en Met de zon mee volgen ook terwijl de pagina open staat
matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (themeMode === 'system') applyTheme('system', false, false); });
setInterval(() => { if (themeMode === 'sun') { const t = resolveTheme('sun'); if (t !== document.documentElement.dataset.theme) applyTheme('sun'); } }, 60000);
document.querySelectorAll('[data-set-theme]').forEach(b => b.addEventListener('click', () => window.STROOM_SET_THEME(b.dataset.setTheme, b)));
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
document.querySelectorAll('.pg-kbd').forEach(k => { k.textContent = isMac ? '⌘K' : 'Ctrl K'; });

/* ── Hero: het licht staat op de echte stand van de zon boven Lopik ── */
const hero = document.querySelector('.pg-hero');
const heroLight = createLight(hero, { scale: .25, seed: 3 });
LIGHTS.push(heroLight);
const placeHeroSun = () => { const s = sunTimes(new Date()); const p = sunPlace(nowMin(), s.rise, s.set); heroLight.sun(p.x, Math.min(.97, p.y + .06), Math.max(.18, p.amt), true); };
placeHeroSun(); setInterval(placeHeroSun, 60000);
STREAMS.push(createStream(document.querySelector('.pg-hero-stream'), { mode: 'hero', label: 'De stroom: van gesprek tot betaald' }));

/* ── Het prototype ── */
const frame = document.getElementById('frame');
let protoInView = false;
const main = createApp(frame, {
  keys: () => protoInView || frame.classList.contains('is-full'),
  route: QS.get('scherm') || 'vandaag',
  onRoute: r => markScreen(r),
});
APPS.push(main);
window.__main = main;   // voor de controles en de beelden
function markScreen(r) {
  const base = r.split(':')[0];
  const want = base === 'klant' || base === 'werk' ? 'klant:korenaar' : base === 'factuur' || base === 'geld' ? 'factuur:2026-041' : base;
  document.querySelectorAll('[data-screen]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.screen === want)));
}
markScreen(main.state.route);
document.querySelectorAll('[data-screen]').forEach(b => b.addEventListener('click', () => main.go(b.dataset.screen)));
// De eerste keer dat het prototype in beeld komt, wordt de werkruimte wakker
let woke = false;
if (window.IntersectionObserver) {
  new IntersectionObserver(es => {
    protoInView = es[0].intersectionRatio > .35;
    if (protoInView && !woke) { woke = true; if (main.state.route === 'vandaag') main.wake(); }
  }, { threshold: [0, .35, .6] }).observe(frame);
} else protoInView = true;

function toProto(fn) {
  const r = frame.getBoundingClientRect();
  const visible = r.top > -80 && r.top < innerHeight * .35;
  if (!visible && !frame.classList.contains('is-full')) {
    frame.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center' });
    woke = true;
    setTimeout(fn, reducedMotion() ? 0 : 520);
  } else fn();
}
function typeInto(text) {
  main.island.open('');
  const inp = main.island.el.querySelector('input');
  if (reducedMotion()) { inp.value = text; inp.dispatchEvent(new Event('input')); return; }
  let i = 0;
  const t = setInterval(() => { inp.value = text.slice(0, ++i); inp.dispatchEvent(new Event('input')); if (i >= text.length) clearInterval(t); }, 42);
}
const leaveLogin = () => { if (main.state.route === 'login') main.go('vandaag'); };
const DEMOS = {
  island: () => toProto(() => { leaveLogin(); setTimeout(() => main.island.open(), 60); }),
  factuur: () => toProto(() => { leaveLogin(); setTimeout(() => typeInto('factuur bloem content oktober 650'), 120); }),
  akkoord: () => toProto(() => {
    if (main.island.isOpen()) main.island.close();
    const d = main.state.decisions.find(x => x.id === 'd1');
    if (d && (d.done || d.dismissed)) { d.done = false; d.dismissed = false; }
    if (main.state.route !== 'vandaag') main.go('vandaag');
    setTimeout(() => { main.openDecision('d1'); const b = frame.querySelector('.dk-card.k0 [data-how="A"]'); if (b) { b.focus({ preventScroll: true }); b.animate([{ boxShadow: '0 0 0 0 var(--gold-glow)' }, { boxShadow: '0 0 0 10px transparent' }], { duration: 900, iterations: 2 }); } }, 420);
  }),
  pay: () => toProto(() => { if (main.island.isOpen()) main.island.close(); main.pay(); }),
  klant: () => toProto(() => main.go('klant:korenaar')),
  plan: () => toProto(() => main.go('agenda', { plan: true })),
  login: () => toProto(() => main.go('login')),
  wake: () => toProto(() => main.wake()),
  stroom: () => toProto(() => { main.go('vandaag'); setTimeout(() => { const s = frame.querySelector('.vd-stream'); if (s) s.scrollIntoView({ block: 'nearest' }); }, 500); }),
  gerrie: () => toProto(() => main.go('gerrie')),
  full: () => toggleFull(),
};
document.addEventListener('click', e => { const b = e.target.closest('[data-demo]'); if (b && DEMOS[b.dataset.demo]) { e.preventDefault(); DEMOS[b.dataset.demo](); } });

// Volledig scherm: het venster groeit naar de randen van je scherm
const fullBtn = document.querySelector('[data-demo="full"]');
const closeFull = document.createElement('button');
closeFull.type = 'button'; closeFull.className = 'btn btn-sm pg-frame-close glass glass-3'; closeFull.hidden = true;
closeFull.innerHTML = `${ic('minimize-2')}<kbd>Esc</kbd>`;
closeFull.setAttribute('aria-label', 'Sluit volledig scherm');
closeFull.title = 'Sluit volledig scherm';
closeFull.addEventListener('click', () => toggleFull(false));
frame.appendChild(closeFull);
function toggleFull(force) {
  const on = typeof force === 'boolean' ? force : !frame.classList.contains('is-full');
  const apply = () => {
    frame.classList.toggle('is-full', on);
    document.body.classList.toggle('has-full', on);
    closeFull.hidden = !on;
    fullBtn.setAttribute('aria-pressed', String(on));
    fullBtn.querySelector('span').textContent = on ? 'Sluit volledig scherm' : 'Volledig scherm';
  };
  if (document.startViewTransition && !reducedMotion()) {
    frame.style.viewTransitionName = 'pg-frame';
    const t = document.startViewTransition(apply);
    t.finished.finally(() => { frame.style.viewTransitionName = ''; main.island.fit(); });
  } else { apply(); main.island.fit(); }
  if (on) setTimeout(() => frame.querySelector('.scr').focus({ preventScroll: true }), 50);
}
document.addEventListener('keydown', e => { if (e.key === 'Escape' && frame.classList.contains('is-full') && !main.island.isOpen()) toggleFull(false); });

/* ── Drie telefoons: hetzelfde prototype op 390 breed ── */
document.querySelectorAll('[data-phone]').forEach(el => {
  const kind = el.dataset.phone;
  const a = createApp(el, { route: kind === 'gerrie' ? 'gerrie' : 'vandaag', phoneFrame: true, noVT: true, cls: 'is-phone' });
  APPS.push(a);
  if (kind === 'eiland') {
    // Het eiland staat open met een opdracht; Gerrie bouwt de factuur
    setTimeout(() => {
      a.island.open('', { focus: false });
      const inp = a.island.el.querySelector('input');
      inp.value = 'factuur bloem content oktober 650';
      inp.dispatchEvent(new Event('input'));
    }, 600);
  }
});
const fitPhones = () => document.querySelectorAll('.pg-ph-box').forEach(b => {
  const w = b.parentElement.clientWidth;
  b.style.setProperty('--k', Math.max(.6, Math.min(.78, (w - 20) / 390)).toFixed(3));
});
fitPhones();
addEventListener('resize', fitPhones);

/* ── Systeem: kleuren en contrast, uit dezelfde tokens ── */
const SWATCH = [['ground', 'Grond'], ['glass', 'Glas, kaart'], ['ink', 'Inkt 1'], ['ink-2', 'Inkt 2'], ['ink-3', 'Inkt 3'], ['gold', 'Zongoud, vulling'], ['gold-ink', 'Goud als tekst'], ['ok', 'Gelukt'], ['warn', 'Let op'], ['danger', 'Te laat'], ['info', 'Info'], ['ai-1', 'Poollicht 1'], ['ai-2', 'Poollicht 2'], ['ai-3', 'Poollicht 3'], ['flow-1', 'Stroom: maanlicht'], ['flow-2', 'Stroom: zongoud'], ['lf-a1', 'Lichtveld: violet'], ['lf-a2', 'Lichtveld: blauw'], ['lf-sun', 'Lichtveld: zon']];
const rgbOf = v => { v = v.trim(); if (v.startsWith('rgba') || v.startsWith('rgb')) { const m = v.match(/[\d.]+/g).map(Number); return { c: [m[0], m[1], m[2]], a: m[3] == null ? 1 : m[3] }; } const h = hexRgb(v); return { c: h.map(x => Math.round(x * 255)), a: 1 }; };
const lumOf = c => c.map(v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }).reduce((s, v, i) => s + v * [.2126, .7152, .0722][i], 0);
const ratio = (a, b) => { const x = lumOf(a), y = lumOf(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
const mixC = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const over = (top, bottom) => mixC(bottom, top.c, top.a);
const hx = c => '#' + c.map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
(function swatches() {
  const host = document.querySelector('[data-swatches]'); if (!host) return;
  host.innerHTML = SWATCH.map(([k, name]) => {
    const [n, d] = TOKENS[k];
    const cn = rgbOf(n), cd = rgbOf(d);
    const nb = over(cn, rgbOf(TOKENS['ground'][0]).c), db = over(cd, rgbOf(TOKENS['ground'][1]).c);
    const lab = bg => lumOf(bg) > .3 ? '#1C1B18' : '#F4F3F0';
    const paint = (v, i) => v.startsWith('rgba') ? `linear-gradient(${v},${v}),${TOKENS['ground'][i]}` : v;
    return `<div class="pg-sw-i"><div class="pg-sw-c"><i style="background:${paint(n, 0)};color:${lab(nb)}">Nacht</i><i style="background:${paint(d, 1)};color:${lab(db)}">Dag</i></div><b>${name}</b><span>--${k}<br>${n.startsWith('rgba') ? n.replace(/\s/g, '') : n} · ${d.startsWith('rgba') ? d.replace(/\s/g, '') : d}</span></div>`;
  }).join('');
})();
(function contrast() {
  const host = document.querySelector('[data-contrast]'); if (!host) return;
  const T = (k, i) => rgbOf(TOKENS[k][i]);
  // Het felste licht dat onder een kaart mag komen
  const nSun = mixC(T('lf-base', 0).c, T('lf-sun', 0).c, .30);
  const nAur = mixC(T('lf-base', 0).c, T('lf-a1', 0).c, .72);
  const dayClient = Object.values(CLIENTS).map(c => mixC(T('lf-base', 1).c, hexRgb(c.color).map(v => Math.round(v * 255)), .40)).sort((a, b) => lumOf(a) - lumOf(b))[0];
  const dSun = mixC(T('lf-base', 1).c, T('lf-sun', 1).c, .46);
  const cols = [['Nacht · glas boven 30% zon', 0, nSun], ['Nacht · glas boven poollicht', 0, nAur], ['Dag · glas boven 40% klantkleur', 1, dayClient], ['Dag · glas boven de zon', 1, dSun]];
  const rows = [['ink', 'Inkt 1'], ['ink-2', 'Inkt 2'], ['ink-3', 'Inkt 3'], ['gold-ink', 'Goud als tekst'], ['ok', 'Gelukt'], ['warn', 'Let op'], ['danger', 'Te laat'], ['info', 'Info'], ['ai-ink', 'Poollicht als tekst']];
  host.innerHTML = `<thead><tr><th scope="col">Tekst</th>${cols.map(c => `<th scope="col">${c[0]}</th>`).join('')}</tr></thead><tbody>${rows.map(([k, name]) => `<tr><th scope="row"><span class="sw" style="background:linear-gradient(90deg,${TOKENS[k][0]} 50%,${TOKENS[k][1]} 50%)"></span>${name}</th>${cols.map(([, i, back]) => { const bg = over(T('glass', i), back); const v = ratio(T(k, i).c, bg); return `<td><span class="${v >= 4.5 ? 'ok' : 'no'}">${v.toFixed(2).replace('.', ',')}:1</span> <span class="sw" style="background:${hx(bg)};margin:0 0 0 6px" title="Grond ${hx(bg)}"></span></td>`; }).join('')}</tr>`).join('')}</tbody>`;
})();
(function curve() {
  const host = document.querySelector('[data-curve]'); if (!host) return;
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--spring').trim();
  const m = raw.match(/linear\((.*)\)/); if (!m) { host.hidden = true; return; }
  const pts = m[1].split(',').map(s => { const [v, p] = s.trim().split(/\s+/); return { y: parseFloat(v), x: p ? parseFloat(p) / 100 : null }; });
  pts[0].x = 0; pts[pts.length - 1].x = 1;
  for (let i = 1; i < pts.length - 1; i++) if (pts[i].x == null) { let j = i; while (pts[j].x == null) j++; const a = pts[i - 1].x, b = pts[j].x; for (let k = i; k < j; k++) pts[k].x = a + (b - a) * (k - i + 1) / (j - i + 1); }
  const W = 420, H = 160, X = x => 30 + x * (W - 50), Y = y => H - 22 - y / 1.2 * (H - 40);
  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="De veer van Stroom: schiet 16% door en komt na 0,6 seconde tot rust">
    <line class="ax" x1="30" x2="${W - 20}" y1="${Y(1)}" y2="${Y(1)}"/><line class="ax" x1="30" x2="${W - 20}" y1="${Y(0)}" y2="${Y(0)}"/>
    <text x="22" y="${Y(1) + 4}" text-anchor="end">1</text><text x="22" y="${Y(0) + 4}" text-anchor="end">0</text>
    <path class="cv" d="${pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join('')}"/>
    <circle class="dot" cx="${X(.243)}" cy="${Y(1.149)}" r="3.5"/><text x="${X(.243) + 8}" y="${Y(1.149) - 6}">+16%</text>
    <text x="30" y="${H - 4}">0 ms</text><text x="${W - 20}" y="${H - 4}" text-anchor="end">600 ms</text></svg>`;
})();
(function material() {
  const host = document.querySelector('[data-matfield]'); if (!host) return;
  const l = createLight(host, { scale: .35, seed: 11 });
  l.sun(.22, .9, 1, true);
  LIGHTS.push(l);
})();
const rm = document.querySelector('[data-reduce]');
if (rm) {
  rm.checked = reducedMotion();
  rm.addEventListener('change', () => { if (rm.checked) document.documentElement.dataset.motion = 'reduce'; else delete document.documentElement.dataset.motion; LIGHTS.forEach(x => x.draw()); });
}
