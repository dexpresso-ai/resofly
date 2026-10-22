/* ══ De pagina rond het prototype ═══════════════════════════════════════════ */
const root = document.documentElement;
const sysLight = () => matchMedia('(prefers-color-scheme: light)').matches;
const effective = () => root.getAttribute('data-theme') || (sysLight() ? 'light' : 'dark');
let MODE = 'auto', lastWant = null, selfSet = false;
const wantTheme = m => m === 'dag' ? 'light' : m === 'nacht' ? 'dark' : m === 'zon' ? (isDay(S.time) ? 'light' : 'dark') : null;

/* Thema wisselen: de nieuwe dag (of nacht) groeit als een cirkel vanuit de zon of de knop. */
function applyTheme(want, origin) {
  const next = want || (sysLight() ? 'light' : 'dark');
  const doIt = () => { selfSet = true; if (want) root.setAttribute('data-theme', want); else root.removeAttribute('data-theme'); setTimeout(() => { selfSet = false; }, 0); };
  if (next === effective() || !document.startViewTransition || reduced()) { doIt(); return; }
  const x = origin ? origin.x : innerWidth / 2, y = origin ? origin.y : 0;
  const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  try {
    const vt = document.startViewTransition(doIt);
    vt.ready.then(() => root.animate({ clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] }, { duration: 700, easing: 'cubic-bezier(.2,.8,.2,1)', pseudoElement: '::view-transition-new(root)' })).catch(() => {});
  } catch (e) { doIt(); }
}
function syncModeUi() {
  $$('[data-pmode]').forEach(b => b.setAttribute('aria-pressed', b.dataset.pmode === MODE));
  if (!$('#pop').hidden) renderPop();
}
setMode = (mode, el) => {
  MODE = mode;
  try { localStorage.setItem('zenit.mode', mode); } catch (e) { /* privé venster: niet erg */ }
  let origin = null;
  if (el && el.getBoundingClientRect) { const r = el.getBoundingClientRect(); origin = { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }
  if (mode === 'zon') origin = sunScreenPoint() || origin;
  lastWant = wantTheme(mode);
  applyTheme(lastWant, origin);
  syncModeUi();
};
getMode = () => MODE;
sunTheme = () => {
  if (MODE !== 'zon') return;
  const want = wantTheme('zon');
  if (want === lastWant) return;
  lastWant = want; applyTheme(want, sunScreenPoint());
};
// Zet de viewer (of iemand anders) het thema, dan volgt de knop.
new MutationObserver(() => {
  if (selfSet) return;
  const t = root.getAttribute('data-theme');
  MODE = t === 'light' ? 'dag' : t === 'dark' ? 'nacht' : 'auto';
  syncModeUi();
}).observe(root, { attributes: true, attributeFilter: ['data-theme'] });

/* ── Het prototype schalen ── */
function fit() {
  const fr = $('#frame'); if (!fr) return;
  appScale = fr.clientWidth / 1440;
  $('#app').style.transform = `scale(${appScale})`;
  fr.style.height = Math.round(900 * appScale) + 'px';
  if (S.notes) placeNotes();
}

/* ── Naar het prototype en iets laten zien ── */
function inView(el) { const r = el.getBoundingClientRect(); return r.top < innerHeight * .6 && r.bottom > innerHeight * .4; }
function toProto(cb) {
  const fr = $('#frame');
  if (inView(fr)) { cb(); return; }
  $('#prototype').scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'start' });
  setTimeout(cb, reduced() ? 0 : 700);
}
const DEMOS = {
  cmdk: () => { closePeek(true); demoType('factuur bloem content oktober 650'); },
  play: () => { closeCk(); if (S.screen !== 'vandaag') go('vandaag'); setTimeout(() => { if (S.time > 1200) setTime(DEMO.now); play(); }, 200); },
  gerrie: () => { closeCk(); go('gerrie'); },
  peek: () => { closeCk(); go('facturen'); setTimeout(() => openPeek('2026-040'), 120); },
  klant: () => { closeCk(); go('klant'); },
  sunset: () => { closeCk(); if (S.screen !== 'vandaag') go('vandaag'); setMode('zon'); setTimeout(() => { setTime(Math.min(S.time, SUN.set - 140)); tweenTime(SUN.set + 25, 2600); }, 260); },
};

/* ── Hero: de zon klimt naar het zenit ── */
function hero() {
  $('.hero-stars').innerHTML = Array.from({ length: 40 }, (_, i) => `<i style="left:${((i * 37.3 + 11) % 100).toFixed(1)}%;top:${((i * 23.9 + 5) % 100).toFixed(1)}%;opacity:${(.25 + (i * 7 % 10) / 16).toFixed(2)}"></i>`).join('');
  $$('[data-sun]').forEach(b => { b.textContent = hm(SUN[b.dataset.sun]); });
  const path = $('#h-past'), sun = $('#h-sun'), glow = $('#h-glow');
  const L = path.getTotalLength(), target = .5;
  const place = k => { const p = path.getPointAtLength(L * k); sun.setAttribute('cx', p.x.toFixed(1)); sun.setAttribute('cy', p.y.toFixed(1)); glow.setAttribute('cx', p.x.toFixed(1)); glow.setAttribute('cy', p.y.toFixed(1)); path.style.strokeDasharray = `${(L * k).toFixed(1)} ${L.toFixed(1)}`; };
  if (reduced()) { place(target); return; }
  const t0 = performance.now(), ms = 2400, ease = k => 1 - Math.pow(1 - k, 3);
  place(0);
  const step = now => { const k = Math.min(1, (now - t0) / ms); place(target * ease(k)); if (k < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}

/* ── Kleuren met hun contrast, nagerekend op wat je ziet ── */
const hexRgb = h => { h = h.trim().replace('#', ''); if (h.length === 3) h = h.split('').map(c => c + c).join(''); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255); };
const lum = h => { const [r, g, b] = hexRgb(h).map(v => v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4)); return .2126 * r + .7152 * g + .0722 * b; };
const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
function palettes() {
  const SW = [['ground', 'Grond', 'onder rail en werkvlak'], ['canvas', 'Werkvlak', 'het papier waarop je werkt'], ['surface', 'Kaart', 'wat een eigen object is'], ['ink', 'Inkt', 'titels en tekst', 'txt'], ['ink-2', 'Inkt 2', 'lopende tekst', 'txt'], ['ink-3', 'Inkt 3', 'labels en hulptekst', 'txt'], ['gold', 'Zongoud', 'hoofdactie, focus, waar je bent', 'fill'], ['gold-ink', 'Goud als tekst', 'links en accenten', 'txt'], ['ok', 'Gelukt', 'betaald, klaar', 'txt'], ['warn', 'Let op', 'bijna te laat', 'txt'], ['danger', 'Te laat', 'vervallen, fout', 'txt'], ['info', 'Info', 'openstaand, onderweg', 'txt'], ['ai-ink', 'Poollicht', 'alles wat Gerrie maakt', 'txt']];
  $$('.pal').forEach(pal => {
    const cs = getComputedStyle(pal), v = n => cs.getPropertyValue('--' + n).trim();
    const grounds = [v('surface'), v('canvas'), v('ground')];
    pal.querySelector('.pal-grid').innerHTML = SW.map(([k, n, d, kind]) => {
      const val = v(k); let badge = '';
      if (kind === 'txt') { const c = Math.min(...grounds.map(g => contrast(val, g))); badge = `<span class="pill ${c >= 7 ? 'ok' : c >= 4.5 ? 'info' : 'danger'}" title="Laagste contrast op kaart, werkvlak en grond">${c.toFixed(1).replace('.', ',')} ${c >= 7 ? 'AAA' : c >= 4.5 ? 'AA' : '✕'}</span>`; }
      if (kind === 'fill') { const c = contrast(v('on-gold'), val); badge = `<span class="pill ok" title="Tekst op goud">${c.toFixed(1).replace('.', ',')} AAA</span>`; }
      const chip = k === 'ai-ink' ? `background:linear-gradient(135deg,${v('ai-1')},${v('ai-2')},${v('ai-3')})` : `background:${val}`;
      return `<div class="sw"><span class="sw-chip" style="${chip}"></span><span class="sw-n">${n}<small>${d}</small></span><span class="sw-hex">${val.toUpperCase()}</span><span class="sw-cr">${badge}</span></div>`;
    }).join('');
  });
}

/* ── Beweging laten zien ── */
function motionDemo(n, btn) {
  const dot = btn.querySelector('.mo-dot'); if (!dot || reduced()) return;
  if (n === '1') dot.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.35)' }, { transform: 'scale(1)' }], { duration: 240, easing: 'cubic-bezier(.2,.8,.2,1)' });
  if (n === '2') dot.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(120px)' }], { duration: 200, easing: 'cubic-bezier(.34,1.45,.64,1)', fill: 'forwards' }).finished.then(() => setTimeout(() => dot.animate([{ transform: 'translateX(120px)' }, { transform: 'translateX(0)' }], { duration: 200, easing: 'cubic-bezier(.34,1.45,.64,1)', fill: 'forwards' }), 350));
  if (n === '3') dot.animate([{ transform: 'translateX(0)', opacity: 1 }, { transform: 'translateX(120px)', opacity: .4 }], { duration: 320, easing: 'cubic-bezier(.16,1,.3,1)', fill: 'forwards' }).finished.then(() => setTimeout(() => dot.animate([{ transform: 'translateX(120px)', opacity: .4 }, { transform: 'translateX(0)', opacity: 1 }], { duration: 320, easing: 'cubic-bezier(.16,1,.3,1)', fill: 'forwards' }), 350));
  if (n === '4') dot.animate([{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(14)', opacity: .0 }], { duration: 700, easing: 'cubic-bezier(.2,.8,.2,1)' });
}

/* ── De Dagboog in het klein (telefoon) ── */
function phoneArc() {
  const el = $('#m-arc'); if (!el) return;
  const W = 350, H = 120, hz = 98, A = 70, x = t => 14 + (t - 450) / (1170 - 450) * (W - 28);
  const y = t => { const s = Math.sin(Math.PI * (t - SUN.rise) / (SUN.set - SUN.rise)); return hz - A * (s >= 0 ? s : s * .3); };
  const P = (a, b) => { let d = ''; for (let t = a; t <= b; t += 6) d += (d ? 'L' : 'M') + x(t).toFixed(1) + ' ' + y(t).toFixed(1); return d; };
  const now = DEMO.now;
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" aria-hidden="true"><line x1="0" x2="${W}" y1="${hz}" y2="${hz}" stroke="var(--line-2)"></line><path d="${P(450, SUN.rise)}" fill="none" stroke="var(--line-3)" stroke-dasharray="1 5" stroke-linecap="round"></path><path d="${P(SUN.rise, SUN.set)}" fill="none" stroke="var(--line-3)" stroke-dasharray="4 5"></path><path d="${P(SUN.set, 1170)}" fill="none" stroke="var(--line-3)" stroke-dasharray="1 5" stroke-linecap="round"></path><path d="${P(SUN.rise, now)}" fill="none" stroke="var(--gold)" stroke-width="2.5" stroke-linecap="round"></path>${TODAY.map(e => `<path d="${P(e.s, e.e)}" fill="none" stroke="${evColor(e)}" stroke-width="6" stroke-linecap="round" opacity="${e.kind === 'focus' ? .45 : .95}"></path>`).join('')}<circle cx="${x(now)}" cy="${y(now)}" r="14" fill="var(--gold)" opacity=".18"></circle><circle cx="${x(now)}" cy="${y(now)}" r="8" fill="var(--gold)"></circle><text x="${x(now) + 8}" y="${y(now) + 24}" font-size="11" font-weight="600" fill="var(--ink)" font-family="Poppins, sans-serif">09:41</text><text x="${x(SUN.rise)}" y="${hz + 15}" font-size="10" fill="var(--ink-3)" text-anchor="middle" font-family="Poppins, sans-serif">${hm(SUN.rise)}</text><text x="${x(SUN.set)}" y="${hz + 15}" font-size="10" fill="var(--ink-3)" text-anchor="middle" font-family="Poppins, sans-serif">${hm(SUN.set)}</text></svg>`;
}

/* ── Opstarten ── */
function boot() {
  try { const m = localStorage.getItem('zenit.mode'); if (['dag', 'nacht', 'zon', 'auto'].includes(m)) MODE = m; } catch (e) { /* geen opslag */ }
  if (MODE !== 'auto') { lastWant = wantTheme(MODE); selfSet = true; root.setAttribute('data-theme', lastWant); setTimeout(() => { selfSet = false; }, 0); }
  mountApp($('#app'));
  syncModeUi();
  fit();
  if (window.ResizeObserver) new ResizeObserver(fit).observe($('#frame')); else addEventListener('resize', fit);

  onScreen = screen => { $$('[data-screen]').forEach(b => b.setAttribute('aria-selected', b.dataset.screen === screen)); };
  onNote = n => {
    const bar = $('#notebar');
    if (!n) { bar.hidden = true; return; }
    bar.hidden = false; $('#nb-n').textContent = n.i + 1; $('#nb-t').textContent = n.t; $('#nb-d').textContent = n.d; $('#nb-c').textContent = `${n.i + 1} van ${n.n}`;
  };
  $$('[data-screen]').forEach(b => b.addEventListener('click', () => { closeCk(); go(b.dataset.screen); }));
  $$('[data-pmode]').forEach(b => b.addEventListener('click', () => setMode(b.dataset.pmode, b)));
  $$('[data-demo]').forEach(b => b.addEventListener('click', () => { const f = DEMOS[b.dataset.demo]; f && toProto(f); }));
  $$('[data-motion]').forEach(b => b.addEventListener('click', () => motionDemo(b.dataset.motion, b)));
  const nt = $('#notes-toggle');
  nt.addEventListener('click', () => { S.notes = !S.notes; S.note = 0; nt.setAttribute('aria-pressed', S.notes); if (S.notes) { toProto(placeNotes); } else { placeNotes(); onNote(null); } });
  const step = d => showNote(S.note + d);
  $('#nb-prev').addEventListener('click', () => step(-1));
  $('#nb-next').addEventListener('click', () => step(1));

  document.addEventListener('keydown', e => {
    const fr = $('#frame');
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); if (S.ck.open) closeCk(); else toProto(() => openCk('')); return; }
    if (S.ck.open || inView(fr) || fr.contains(document.activeElement)) appKeys(e);
  });

  hero(); palettes(); phoneArc();
  matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', () => { if (MODE === 'auto') syncModeUi(); });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
